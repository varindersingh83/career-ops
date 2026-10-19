/**
 * scripts/loop/notify.mjs — Telegram output for the cloud apply loop.
 *
 * Two channels, either or both:
 *   - Direct bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID): messages, PDF attachments,
 *     ✅/⏭ buttons, and commands (/status, /pause, ...). Use a bot dedicated to this
 *     loop: getUpdates long-polling conflicts with any other poller on the same bot.
 *   - Alert relay (ALERT_API_URL + ALERT_API_KEY): text-only, through a deployed
 *     email-alert service (POST /send, queued in Postgres, retried with backoff).
 *     Used for alerts when the direct bot is not configured or a send fails.
 */

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { truncate } from './lib.mjs';

export function createNotifier(config, log = console) {
  const { botToken, chatId } = config.telegram;
  const relay = config.alertRelay;
  const direct = Boolean(botToken && chatId);
  const relayOn = Boolean(relay.url && relay.apiKey);
  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const api = method => `${base}/bot${botToken}/${method}`;

  async function call(method, body) {
    const res = await fetch(api(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 60_000 : 20_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  async function viaRelay(text, key) {
    const res = await fetch(`${relay.url}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${relay.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key ?? `career-ops-loop-${randomUUID()}`,
      },
      body: JSON.stringify(relay.destination ? { text, destination: relay.destination } : { text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`alert relay: HTTP ${res.status}`);
  }

  /** Send text. Falls back to the relay so an alert still lands if the bot call fails. */
  async function send(text, { buttons, key } = {}) {
    const body = truncate(text, 4000);
    if (direct) {
      try {
        const payload = { chat_id: chatId, text: body, disable_web_page_preview: true };
        if (buttons) payload.reply_markup = { inline_keyboard: buttons };
        await call('sendMessage', payload);
        return true;
      } catch (err) {
        log.error(`[notify] direct send failed: ${err.message}`);
      }
    }
    if (relayOn) {
      try {
        await viaRelay(body, key);
        return true;
      } catch (err) {
        log.error(`[notify] relay send failed: ${err.message}`);
      }
    }
    if (!direct && !relayOn) log.log(`[notify] (no channel configured)\n${body}`);
    return false;
  }

  async function sendDocument(path, caption = '') {
    if (!direct) return false;
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      if (caption) form.append('caption', truncate(caption, 1000));
      form.append('document', new Blob([await readFile(path)]), basename(path));
      const res = await fetch(api('sendDocument'), { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(json.description ?? res.status);
      return true;
    } catch (err) {
      log.error(`[notify] sendDocument failed: ${err.message}`);
      return false;
    }
  }

  /** Long-poll for messages and button taps from the configured chat only. */
  async function getUpdates(offset) {
    if (!direct) return [];
    const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    return updates;
  }

  async function answerCallback(id, text) {
    if (!direct) return;
    await call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
  }

  return { send, sendDocument, getUpdates, answerCallback, interactive: direct, chatId };
}
