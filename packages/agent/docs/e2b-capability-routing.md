# Cloud Sandbox Capability Router

This router lets semantic plugins use filesystem, terminal, and local Git
capabilities without owning the execution substrate.

```text
plugin-coding-tools
  -> capability-router runtime service
  -> sandbox provider
  -> fs / pty / git execution
```

Active providers:

| Provider | Runner | Use |
| --- | --- | --- |
| `e2b` | E2B SDK sandbox | Hosted coding sandbox when E2B credentials are configured. |
| `eliza-cloud` | Eliza Cloud Satellite HTTP runner | Managed cloud runner and coding-agent container path. |
| `home` | Home Satellite HTTP runner | User-owned machine reachable directly, through Eliza Cloud routing, or through SSH tunnel. |

Direct `vercel`, `cloudflare`, and `rivet` providers are intentionally disabled
until they are exposed through Eliza Cloud or another reviewed product option.

## Activation

Select the provider:

```text
ELIZA_CODING_SATELLITE_RUNNER=e2b
ELIZA_CODING_SATELLITE_RUNNER=eliza-cloud
ELIZA_CODING_SATELLITE_RUNNER=home
```

`ELIZA_SATELLITE_RUNNER` is also accepted. E2B additionally accepts the legacy
flag:

```text
ELIZA_E2B_SATELLITE_RUNNER=1
```

If no provider is selected, the router auto-selects `eliza-cloud` when a direct
cloud runner URL is present, `home` when home runner settings are present, and
otherwise stays disabled unless E2B is explicitly enabled.

## E2B

```text
E2B_API_KEY
E2B_ACCESS_TOKEN
E2B_DOMAIN
E2B_SANDBOX_ID
E2B_TEMPLATE
ELIZA_E2B_WORKDIR
ELIZA_E2B_HOST_WORKSPACE_ROOT
ELIZA_E2B_BOOTSTRAP_GIT_URL
ELIZA_E2B_BOOTSTRAP_GIT_REF
ELIZA_E2B_KEEP_ALIVE=1
ELIZA_E2B_TIMEOUT_MS
ELIZA_E2B_REQUEST_TIMEOUT_MS
```

## Eliza Cloud

```text
ELIZA_CLOUD_SANDBOX_API_BASE_URL
ELIZA_CLOUD_SANDBOX_BASE_URL
ELIZA_CLOUD_SATELLITE_RUNNER_URL
ELIZA_CLOUD_RUNNER_URL
ELIZA_CLOUD_SANDBOX_TOKEN
ELIZA_CLOUD_API_KEY
ELIZA_CLOUD_AUTH_TOKEN
ELIZAOS_CLOUD_API_KEY
ELIZACLOUD_API_KEY
ELIZA_CLOUD_SANDBOX_ACCESS_URL
ELIZA_CLOUD_SANDBOX_IMAGE
ELIZA_CLOUD_SATELLITE_IMAGE
ELIZA_CLOUD_CODING_SATELLITE_IMAGE
ELIZA_CLOUD_SANDBOX_WORKDIR
ELIZA_CLOUD_SANDBOX_HOST_WORKSPACE_ROOT
ELIZA_CLOUD_SANDBOX_BOOTSTRAP_GIT_URL
ELIZA_CLOUD_SANDBOX_BOOTSTRAP_GIT_REF
ELIZA_CLOUD_SANDBOX_TIMEOUT_MS
ELIZA_CLOUD_SANDBOX_REQUEST_TIMEOUT_MS
```

`ELIZA_CLOUD_SANDBOX_BASE_URL`, `ELIZA_CLOUD_SATELLITE_RUNNER_URL`, and
`ELIZA_CLOUD_RUNNER_URL` are direct Satellite HTTP URLs and must expose
`/v1/health`, `/v1/fs/entries`, `/v1/fs/file`, and `/v1/processes/run`.

If no direct Satellite URL is set, `eliza-cloud` uses the Cloud API at
`ELIZA_CLOUD_SANDBOX_API_BASE_URL` or the default
`https://api.elizacloud.ai/api/v1`, then posts to
`/coding-containers` with `ELIZA_CLOUD_SANDBOX_TOKEN`, `ELIZA_CLOUD_API_KEY`,
`ELIZAOS_CLOUD_API_KEY`, or `ELIZACLOUD_API_KEY`. The returned container URL is
then treated as the Satellite HTTP runner URL.

The Cloud control plane should use the coding Satellite image from
`packages/cloud-services/coding-satellite`. Publish it and set:

```text
ELIZA_CLOUD_CODING_SATELLITE_IMAGE=ghcr.io/elizaos/coding-satellite:<tag>
```

## Home

```text
ELIZA_HOME_SATELLITE_URL
ELIZA_HOME_RUNNER_URL
ELIZA_HOME_SATELLITE_TOKEN
ELIZA_HOME_SATELLITE_ACCESS_URL
ELIZA_HOME_ACCESS_URL
ELIZA_HOME_SATELLITE_WORKDIR
ELIZA_HOME_SATELLITE_HOST_WORKSPACE_ROOT
ELIZA_HOME_SATELLITE_BOOTSTRAP_GIT_URL
ELIZA_HOME_SATELLITE_BOOTSTRAP_GIT_REF
ELIZA_HOME_SATELLITE_TIMEOUT_MS
ELIZA_HOME_SATELLITE_REQUEST_TIMEOUT_MS
```

Optional SSH tunnel metadata for Settings:

```text
ELIZA_HOME_SATELLITE_SSH_TARGET=user@home.example
ELIZA_HOME_SSH_TARGET=user@home.example
ELIZA_HOME_SATELLITE_SSH_IDENTITY=/path/to/key
ELIZA_HOME_SSH_IDENTITY=/path/to/key
ELIZA_HOME_SATELLITE_SSH_LOCAL_PORT=32468
```

The app only renders a copyable SSH tunnel command. It does not spawn or manage
SSH.

## Agent Runners

Eliza Cloud and Home default to:

```text
codex,claude-code,opencode
```

Override with:

```text
ELIZA_SANDBOX_AGENT_RUNNERS=codex,claude-code,opencode
SANDBOX_AGENT_RUNNERS=codex,claude-code,opencode
```

`claude` is normalized to `claude-code`; `open-code` is normalized to
`opencode`.

These are coding-agent runners, not model providers. The sandbox provider
starts the runner in the workspace; Codex, Claude Code, and opencode each use
their own configured auth/model settings inside that runner.

### Codex server mode

For one-shot jobs, a sandbox can run:

```text
codex exec --cd /workspace "..."
```

For streamed, resumable, cross-device coding sessions, prefer Codex app-server
inside the same sandbox workspace:

```text
codex app-server --listen stdio://
codex app-server --listen ws://127.0.0.1:4500
```

The Codex app-server protocol is JSON-RPC 2.0 without the `jsonrpc` wire field.
It supports threads, turns, streamed item events, `command/exec`, model listing,
auth state, and filesystem methods. Loopback WebSocket listeners expose
`/readyz` and `/healthz` probes. If a WebSocket listener is forwarded outside
the sandbox, require WebSocket auth:

```text
codex app-server --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file /run/secrets/codex-ws-token
```

Use `CODEX_BIN` when the binary is not on `PATH`. Use
`CODEX_APP_SERVER_LISTEN`, `CODEX_APP_SERVER_WS_TOKEN_FILE`, and
`CODEX_APP_SERVER_WS_SHARED_SECRET_FILE` for runner images that manage a
long-lived app-server process. `codex` remains the runner id; the runner mode is
`exec` or `app-server`.

### opencode server mode

An opencode-backed sandbox should run opencode as a headless server inside the
same sandbox workspace:

```text
opencode serve --hostname 127.0.0.1 --port 4096
```

Use `OPENCODE_SERVER_PASSWORD` to require HTTP Basic auth. The default username
is `opencode`; set `OPENCODE_SERVER_USERNAME` only when a runner needs a
different account name.

The opencode server provides:

| Path | Purpose |
| --- | --- |
| `/global/health` | Server health and version. |
| `/event` | Server-sent event stream. |
| `/doc` | OpenAPI 3.1 spec. |
| `/session` and `/session/:id/message` | Programmatic coding-agent sessions. |
| `/find`, `/find/file`, `/file`, `/file/content`, `/file/status` | Workspace search and file reads. |
| `/vcs` and `/session/:id/diff` | VCS status and session diff. |

The Satellite HTTP runner remains the outer capability boundary. opencode is an
agent runner inside E2B, Eliza Cloud, or Home, not a fourth sandbox provider.

## Satellite HTTP Contract

Eliza Cloud and Home use the same HTTP runner shape:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Runner readiness. |
| `GET` | `/v1/fs/entries?path=/workspace` | List files. |
| `GET` | `/v1/fs/file?path=/workspace/file.ts` | Read a file. |
| `PUT` | `/v1/fs/file?path=/workspace/file.ts` | Write a file. |
| `POST` | `/v1/processes/run` | Run a command. |

The command request body is:

```json
{
  "command": "sh",
  "args": ["-lc", "git status --short"],
  "cwd": "/workspace",
  "env": {},
  "timeoutMs": 60000
}
```

The command response may use either:

```json
{ "exitCode": 0, "stdout": "ok", "stderr": "" }
```

or the terminal-style shape:

```json
{ "exitCode": 0, "output": "ok", "timedOut": false }
```

## Routed Capabilities

| Capability | Route |
| --- | --- |
| `fs.list` | Provider file listing. |
| `fs.readText` | Provider file read. |
| `fs.writeText` | Provider file write. |
| `pty.command.run` | Provider command execution. |
| `git.status` | `git status --porcelain=v1 --branch` in provider workspace. |
| `git.diff` | `git diff` in provider workspace. |
| `git.command.run` | `git ...args` in provider workspace. |

`model.status` remains unavailable because local model control belongs to model
providers and `eliza.local-model`, not the coding sandbox runner.

## Workspace Mapping

Absolute host paths under the configured host workspace root map into the
provider workdir.

Example:

```text
ELIZA_SANDBOX_HOST_WORKSPACE_ROOT=/Users/me/eliza
ELIZA_SANDBOX_WORKDIR=/workspace

/Users/me/eliza/packages/agent -> /workspace/packages/agent
```

Paths outside the mapped root fail with `CAPABILITY_UNAVAILABLE`.

## Mobile And Cross-Device

Mobile does not need Electrobun. It talks to the same Eliza agent runtime, and
the runtime routes coding capabilities to a reachable provider:

- E2B for hosted sandbox execution.
- Eliza Cloud for managed cloud Satellite execution.
- Home for a user-owned machine reachable by direct URL, cloud routing, or SSH tunnel.

Results return through normal chat, trace, and dynamic-view channels.

## Live Smoke Tests

Run the live smoke harness from the repo root:

```text
bun run --cwd packages/agent test:sandbox-live
```

Without provider credentials, E2B, Eliza Cloud, and Home are reported as
skipped. Codex app-server is always tested locally when `codex` is available.

To require a configured provider:

```text
bun run --cwd packages/agent test:sandbox-live -- --target=e2b --strict
bun run --cwd packages/agent test:sandbox-live -- --target=eliza-cloud --strict
bun run --cwd packages/agent test:sandbox-live -- --target=home --strict
```

The provider smoke writes a temporary file, reads it back, lists the workspace,
runs a shell command, and runs `git --version` through the configured sandbox
route.
