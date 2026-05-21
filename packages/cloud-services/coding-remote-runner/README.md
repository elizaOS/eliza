# Coding Remote

Bun-based HTTP runner image for Eliza Cloud coding containers and home-machine
Remote hosting.

It exposes the contract consumed by `packages/agent/src/services/e2b-capability-router.ts`:

```text
GET  /health
GET  /v1/health
GET  /v1/fs/entries?path=/workspace
GET  /v1/fs/file?path=/workspace/file.ts
PUT  /v1/fs/file?path=/workspace/file.ts
POST /v1/processes/run
```

Required runtime env:

```text
ELIZA_REMOTE_HTTP_TOKEN=<generated per container>
ELIZA_CODING_WORKSPACE=/workspace
```

The image includes `git`, `ripgrep`, `python3`, `openssh-client`, Codex CLI,
Claude Code, and opencode by default. Disable runner installs at build time:

```bash
docker build \
  --build-arg INSTALL_CODEX=false \
  --build-arg INSTALL_CLAUDE_CODE=false \
  --build-arg INSTALL_OPENCODE=false \
  -t ghcr.io/elizaos/coding-remote-runner:local \
  packages/cloud-services/coding-remote-runner
```

Configure Eliza Cloud to use the published image with:

```text
ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE=ghcr.io/elizaos/coding-remote-runner:<tag>
```
