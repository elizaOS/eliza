# Coding remote runner

Bun-based HTTP runner image for Eliza Cloud coding containers and home-machine
Remote runner hosting.

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
ELIZA_REMOTE_RUNNER_HTTP_TOKEN=<generated per container>
ELIZA_CODING_WORKSPACE=/workspace
```

The image includes `git`, `ripgrep`, `python3`, `openssh-client`, Codex CLI,
Claude Code, and opencode by default. It can also install the elizaOS-owned
coding agent (`eliza-code-acp`) once `@elizaos/example-code` is published.
Disable runner installs, or opt into eliza-code, at build time:

```bash
docker build \
  --build-arg INSTALL_CODEX=false \
  --build-arg INSTALL_CLAUDE_CODE=false \
  --build-arg INSTALL_OPENCODE=false \
  --build-arg INSTALL_ELIZA_CODE=true \
  --build-arg ELIZA_CODE_PACKAGE=@elizaos/example-code@2.0.0-beta.0 \
  -t ghcr.io/elizaos/coding-remote-runner:local \
  packages/cloud/services/coding-remote-runner
```

`INSTALL_ELIZA_CODE` defaults to `false` so image builds keep working until the
package exists on npm. The Cloud cutover can enable it and set
`ELIZA_ACP_DEFAULT_AGENT=elizaos` plus
`ELIZA_ELIZAOS_ACP_COMMAND=eliza-code-acp` on the runner environment.

Configure Eliza Cloud to use the published image with:

```text
ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE=ghcr.io/elizaos/coding-remote-runner:<tag>
```
