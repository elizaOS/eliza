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
cerebras (`gpt-oss-120b` fast / `zai-glm-4.7` smart) — a real CLI with all slash
commands, on any device, with zero TOS exposure.

## Plugin surface

- **Service `PtyService`** (`serviceType = "PTY_SERVICE"`, `services/pty-service.ts`)
  — exposes `consoleBridge` (the `ConsoleBridge` the agent server drives) plus
  `startSession` / `stopSession` / `listSessions` / `hasSession`.
- **Routes** (`routes/pty-routes.ts`, authenticated, `rawPath`):
  - `POST /api/pty/sessions` — spawn (`kind: "eliza-code"`; returns `{ session }`).
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
routes/
  pty-routes.ts                spawn / list / stop route handlers
test/
  fake-pty.ts                  Controllable in-memory PTY double + fake spawn
  eliza-code-spec.test.ts      Spec builder + bin resolver
  pty-session-store.test.ts    Bridge routing, streaming, lifecycle, confinement, cap
  pty-service.test.ts          Service wiring
  pty-routes.test.ts           Route handlers (gates, errors, spawn/list/stop)
  pty-real.e2e.test.ts         Gated real-node-pty e2e (excluded from the normal lane)
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
| `PTY_INTERACTIVE_ENABLED` | `true` | Set `false` (or run a store build) to disable spawning. |
| `PTY_ALLOWED_DIRECTORY` | process cwd | Directory sessions are confined to. |
| `PTY_ELIZA_CLOUD_API_KEY` / `OPENAI_API_KEY` | — | Eliza Cloud key eliza-code authenticates with. |
| `ELIZA_CODE_BIN` | auto-resolved | Absolute path to built `eliza-code` `dist/index.js`. |
| `ELIZA_BUILD_VARIANT` | — | `store` disables interactive spawning. |

## How the cerebras wiring works

`buildElizaCodeCerebrasSpec` sets the env eliza-code reads
(`packages/examples/code/src/lib/model-provider.ts`):
`ELIZA_CODE_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`
(`https://api.elizacloud.ai/v1`), and `OPENAI_{SMALL,MEDIUM,LARGE}_MODEL`. The
`tier` (`fast`/`smart`) controls which model small/medium lead with; large is
always the smart model so heavy calls escalate. `CODING_TOOLS_WORKSPACE_ROOTS`
and `SHELL_ALLOWED_DIRECTORY` confine eliza-code's own file/shell tools to the
session cwd.

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
- See the root `AGENTS.md` for repo-wide conventions.

## ⛔ NON-NEGOTIABLE — evidence & real end-to-end tests

The binding standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. The unit suite
proves the store/bridge/routing/spec logic against an injected PTY; the gated
`pty-real.e2e.test.ts` (and the manual real-runtime checks) prove the actual
node-pty / Bun-truePty path spawns real processes, streams output, round-trips
keystrokes, and reports exit codes. The full "real CLI on a phone" proof —
interactive `eliza-code` answering `/help` against live cerebras on-device —
requires a built `eliza-code` bundle + a real Eliza Cloud key and is captured as
the device handoff.
