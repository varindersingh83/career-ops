You are fixing a bug in career-ops found by the cloud apply loop. This checkout is a fresh clone on branch {{BRANCH}}; the RCA is below. The candidate's personal data is NOT in this checkout and must never be added to it.

{{RCA}}

Do this:
1. Reproduce the failure, or write a failing test for it under tests/ that matches the existing test style.
2. Make the smallest change that fixes the root cause. Do not refactor, do not widen scope, do not skip/disable any test, and do not weaken a safety rule (never-submit, source-of-truth, untrusted-content).
3. Run `node test-all.mjs --quick` and make sure it passes.
4. Do not commit or push; the loop does that.

If you conclude it is not a code bug after all, change nothing and say why. End with a one-paragraph summary of the change suitable for a pull request description.
