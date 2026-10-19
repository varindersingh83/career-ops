# career-ops cloud apply loop (docs/CLOUD_LOOP.md).
# Build context is the repository root:  docker build -f scripts/loop/Dockerfile .
# Unlike the dev Dockerfile, sources are copied in: Railway has no bind mount.
# User data never goes in the image; it lives on the /data volume.

FROM mcr.microsoft.com/playwright:v1.64.1-jammy

ARG CLAUDE_CODE_VERSION=latest
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CAREER_OPS_DATA_DIR=/data/career-ops \
    LOOP_WORK_DIR=/tmp \
    IS_SANDBOX=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund \
 && npm install --no-audit --no-fund --save-exact playwright@1.64.1 \
 && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

COPY . .

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/loop/worker.mjs"]
