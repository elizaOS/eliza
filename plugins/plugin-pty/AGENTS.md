# @elizaos/plugin-pty

Interactive PTY terminal service for elizaOS. Registers `PTY_SERVICE` — the one
piece the app's already-built web terminal needs to drive a **real interactive
CLI** (most importantly the interactive `eliza-code` CLI running on Eliza
Cloud/cerebras).

## Purpose / role

The elizaOS app ships the full front half of a web terminal: the xterm UI
(`PtyTerminalPane`), the typed client methods (`spawnShellSession`,
`subscribePtyOutput`, `sendPtyInput`, `resizePty`), and the agent-server
WebSocket handlers (`pty-subscribe` / `pty-input` / `pty-output` / `pty-resize`).
Those handlers call `getPtyConsoleBridge(state)`, which resolves
`runtime.getService("PTY_SERVICE")?.consoleBridge`. **Without a registered
`PTY_SERVICE`, that bridge is `null` and the terminal is inert.**

This plugin supplies that service. It is the missing keystone — everything else
already exists, so this connects three finished pieces (xterm UI, WS keystroke
path, interactive CLI) rather than building them.

It is **opt-in**: add `@elizaos/plugin-pty` to an agent's plugin list. It has no
`autoEnable`, so it stays dormant fleet-wide unless a character explicitly loads
it (intended for the developer-gated cockpit). It disables interactive spawning
automatically on store builds.

## Why eliza-code on cerebras (not the Claude/Codex CLIs)

Running a real interactive CLI *on a subscription* inherently means impersonating
that vendor's CLI — the TOS-unsafe tier. `eliza-code` (`packages/examples/code`)
is a real interactive slash-command TUI **we own**: it already implements
`/help`, `/clear`, `/task`, etc., and selects its model provider purely from env.
Pointing it at Eliza Cloud's OpenAI-compatible endpoint routes inference to
cerebras (`gemma-4-31b` for both fast and smart) — a real CLI with all slash
commands, on any device, with zero TOS exposure.

## Experimental vendor-CLI tier (kind `claude` / `codex`, #10832 Phase 2)

The same `PTY_SERVICE` can spawn the real interactive **Claude Code** /
**Codex** CLIs on the user's own subscription — the TOS-unsafe tier. It is
gated by **`PTY_VENDOR_CLI_ENABLED`** (a separate gate from
`PTY_INTERACTIVE_ENABLED`, default **off**, exact truthy allowlist only, never
on store builds); when off, spawning `kind: "claude" | "codex"` is rejected
with a 403 even if interactive spawning is on.

Spec builders live in `lib/vendor-cli-spec.ts` (`buildClaudeCliSpec` /
`buildCodexCliSpec` + `resolveClaudeCliBin` / `resolveCodexCliBin`). Both CLIs
launch PLAIN (no args) — the interactive TUI, not the `claude --print` /
`codex exec` one-shot paths. Credentials reuse the existing subscription-plugin
conventions: claude gets `CLAUDE_CODE_OAUTH_TOKEN` passed through when
configured (plugin-anthropic-proxy's env credential path), else reads
`~/.claude/.credentials.json` itself via the inherited HOME; codex gets
`CODEX_HOME` passed through when configured (the coding-account-bridge
per-account convention), else reads `~/.codex/auth.json`. The tokens are
opaque passthroughs — never parsed, logged, or persisted here.

## Plugin surface

- **Service `PtyService`** (`serviceType = "PTY_SERVICE"`, `services/pty-service.ts`)
  — exposes `consoleBridge` (the `ConsoleBridge` the agent server drives) plus
  `startSession` / `stopSession` / `listSessions` / `hasSession`.
- **Routes** (`routes/pty-routes.ts`, authenticated + terminal-token gated for
  HTTP callers, `rawPath`):
  - `POST /api/pty/sessions` — spawn (`kind: "eliza-code"` default, or the
    gated `"claude"` / `"codex"`; returns `{ session }`).
  - `GET /api/pty/sessions` — list live sessions.
  - `DELETE /api/pty/sessions/:id` — kill a session.

## Runtime-aware PTY engine

node-pty's write path is **broken under Bun** (`this._socket.write is not a
function` — output streams, keystrokes throw), and the agent runs under Bun in
dev. So `defaultSpawnResolver` (`services/pty-session-store.ts`) picks the engine
by runtime:

- **Bun** → Bun's native truePty (`Bun.spawn({ terminal })`), the same engine the
  Electrobun host uses (`services/bun-pty-spawn.ts`). One gotcha handled here:
  the terminal `exit` callback reports the PTY-teardown status (always `1`), so
  the real exit code is taken from `proc.exited`.
- **Node** → `@lydell/node-pty` (optional native dependency), which works end to
  end.

Both are adapted to one `PtyHandle` interface, so `PtySessionStore` is
engine-agnostic and unit-testable with an injected fake PTY (`test/fake-pty.ts`).

## Layout

```
index.ts                       Plugin def (services + routes + dispose) and public exports
services/
  pty-service.ts               PtyService — the PTY_SERVICE registration
  pty-session-store.ts         PtyConsoleBridge + PtySessionStore + defaultSpawnResolver
  bun-pty-spawn.ts             Bun native truePty adapter (isBunRuntime, bunTruePtySpawn)
  pty-contract.ts              ConsoleBridge/event contract (mirror of packages/agent)
  pty-types.ts                 PtyHandle / PtySpawn / PtySpawnSpec / PtySessionInfo
lib/
  eliza-code-spec.ts           buildElizaCodeCerebrasSpec + resolveElizaCodeBin (pure)
  vendor-cli-spec.ts           buildClaudeCliSpec / buildCodexCliSpec + bin resolvers (pure)
routes/
  pty-routes.ts                spawn / list / stop route handlers
test/
  fake-pty.ts                  Controllable in-memory PTY double + fake spawn
  eliza-code-spec.test.ts      Spec builder + bin resolver
  vendor-cli-spec.test.ts      Vendor spec builders + bin resolvers
  pty-session-store.test.ts    Bridge routing, streaming, lifecycle, confinement, cap
  pty-service.test.ts          Service wiring
  pty-routes.test.ts           Route handlers (gates, errors, spawn/list/stop)
  pty.real.test.ts             Gated real PTY coverage (excluded from the normal lane)
```

## Commands

```bash
bun run --cwd plugins/plugin-pty build      # tsup ESM + declarations
bun run --cwd plugins/plugin-pty test       # vitest unit suite
bun run --cwd plugins/plugin-pty typecheck  # tsgo --noEmit
bun run --cwd plugins/plugin-pty lint
```

## Config / env vars

| Variable | Default | Purpose |
|---|---|---|
| `PTY_INTERACTIVE_ENABLED` | `true` | Explicit values enable only on `true`, `1`, `on`, or `yes`; any other non-empty value disables spawning. Store builds also disable spawning. |
| `PTY_ALLOWED_DIRECTORY` | process cwd | Directory sessions are confined to. |
| `ELIZA_TERMINAL_RUN_TOKEN` | — | Required step-up token for remote HTTP access to PTY spawn/list/stop routes. Trusted loopback cockpit traffic is allowed server-side without exposing the token to browser JavaScript. |
| `PTY_ELIZA_CLOUD_API_KEY` | — | Dedicated Eliza Cloud key eliza-code authenticates with. Do not use the agent server's primary `OPENAI_API_KEY` for PTY sessions. |
| `PTY_ELIZA_CLOUD_FAST_MODEL` / `PTY_ELIZA_CLOUD_SMART_MODEL` | `gemma-4-31b` | Optional deployment pins for the fast/smart eliza-code model ids. Request body model values still take precedence. |
| `PTY_ALLOWED_BASE_URLS` | Eliza Cloud API | Comma-separated operator allowlist for non-default OpenAI-compatible base URLs. |
| `PTY_IDLE_TIMEOUT_MS` | `900000` | Idle live-session timeout. Set `0` to disable the fallback reaper. |
| `ELIZA_CODE_BIN` | auto-resolved | Absolute path to built `eliza-code` `dist/index.js`. |
| `PTY_VENDOR_CLI_ENABLED` | `false` | Experimental vendor-CLI tier (`kind: "claude" \| "codex"` — the real vendor CLI on the user's own subscription). Enables only on `true`, `1`, `on`, or `yes`; never on store builds. |
| `PTY_CLAUDE_BIN` / `PTY_CODEX_BIN` | PATH lookup | Absolute path to the `claude` / `codex` launcher. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Optional Claude Code OAuth token passed through to `kind: "claude"` sessions; without it the CLI reads `~/.claude/.credentials.json`. |
| `CODEX_HOME` | — | Optional codex auth dir passed through to `kind: "codex"` sessions; without it the CLI reads `~/.codex/auth.json`. |
| `ELIZA_BUILD_VARIANT` | — | `store` disables interactive spawning (including the vendor tier). |

## How the cerebras wiring works

`buildElizaCodeCerebrasSpec` sets the env eliza-code reads
(`packages/examples/code/src/lib/model-provider.ts`):
`ELIZA_CODE_PROVIDER=openai`, `ELIZA_CODE_CODING_ONLY=1`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`
(`https://api.elizacloud.ai/v1`), and `OPENAI_{SMALL,MEDIUM,LARGE}_MODEL`. The
`tier` (`fast`/`smart`) controls which model small/medium lead with; large is
always the smart model so heavy calls escalate. `CODING_TOOLS_WORKSPACE_ROOTS`
and `SHELL_ALLOWED_DIRECTORY` confine eliza-code's own file/shell tools to the
session cwd. `--coding-only` / `ELIZA_CODE_CODING_ONLY=1` keeps the cockpit REPL
from loading the orchestrator and recursively spawning sub-agents.

## Conventions / gotchas

- **`pty-contract.ts` must stay structurally in sync** with `ConsoleBridge` /
  `PTYService` in `packages/agent/src/api/parse-action-block.ts`. We redeclare
  it (not import from `@elizaos/agent`) to avoid a dependency cycle — the runtime
  binds them at the `getService` cast.
- **`session_output` / `session_exit`** are the two bridge events. The agent
  server subscribes to `session_output` (`{ sessionId, data }`).
- **node-pty is an `optionalDependency`** (native). Under Bun it isn't used at
  all; under Node it is required for spawning.
- Never log the spawn request body — it can carry an API key.
- PTY child processes do **not** inherit the full server `process.env`; only a
  small runtime allowlist plus explicit eliza-code spec env is passed through.
- See the root `AGENTS.md` for repo-wide conventions.

## ⛔ NON-NEGOTIABLE — evidence & real end-to-end tests

The binding standard is **[AGENTS.md](../../AGENTS.md)**. The unit suite
proves the store/bridge/routing/spec logic against an injected PTY; the gated
`pty.real.test.ts` (and the manual real-runtime checks) prove the actual
node-pty / Bun-truePty path spawns real processes, streams output, round-trips
keystrokes, and reports exit codes. The full "real CLI on a phone" proof —
interactive `eliza-code` answering `/help` against live cerebras on-device —
requires a built `eliza-code` bundle + a real Eliza Cloud key and is captured as
the device handoff.
