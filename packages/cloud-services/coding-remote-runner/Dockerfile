FROM node:24-bookworm-slim

ARG BUN_VERSION=1.3.13
ARG INSTALL_CODEX=true
ARG INSTALL_CLAUDE_CODE=true
ARG INSTALL_OPENCODE=true

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:/usr/local/bin:$PATH
ENV PORT=3000
ENV ELIZA_CODING_WORKSPACE=/workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    ripgrep \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

RUN if [ "$INSTALL_CODEX" = "true" ]; then npm install -g @openai/codex; fi \
  && if [ "$INSTALL_CLAUDE_CODE" = "true" ]; then npm install -g @anthropic-ai/claude-code; fi \
  && if [ "$INSTALL_OPENCODE" = "true" ]; then npm install -g opencode-ai; fi \
  && npm cache clean --force

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /workspace \
  && useradd -m runner \
  && chown -R runner:runner /workspace /app

USER runner

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT}/health || exit 1

CMD ["bun", "run", "src/index.ts"]
