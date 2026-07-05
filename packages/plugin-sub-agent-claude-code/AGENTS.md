# @elizaos/plugin-sub-agent-claude-code

Compatibility package for the reference remote-mode Claude Code sub-agent. The implementation now
lives in `@elizaos/plugin-remote-manifest/sub-agent-claude-code`; this package keeps the historical
`@elizaos/plugin-sub-agent-claude-code` imports working.

## Purpose / role

This compatibility package lets an Eliza agent spawn and communicate with the Claude Code CLI as a
subprocess, with OS-level sandboxing (macOS `sandbox-exec`, Linux `bwrap`) and SOC2-aligned
hardening for env filtering, cwd validation, and binary allowlisting. It implements the consolidated
`@elizaos/plugin-remote-manifest/worker-runtime` remote-plugin contract and is loaded via
`runtime.installRemotePlugin(plugin, { source: { kind: "workspace", pkgName: "@elizaos/plugin-sub-agent-claude-code" } })`.
The wrapper worker entry is `dist/worker.js`; the wrapper host entry (`dist/plugin.js`) re-exports
the `Plugin` descriptor from `@elizaos/plugin-remote-manifest/sub-agent-claude-code`. For repo-wide
conventions see the root `AGENTS.md`.

## Layout

```
packages/plugin-sub-agent-claude-code/
  src/
    plugin.ts / worker.ts / sub-agent-service.ts / sandbox.ts / session-recorder.ts
                         Compatibility re-exports from
                         `@elizaos/plugin-remote-manifest/sub-agent-claude-code*`
  dist/                  Build output (plugin.js, worker.js, *.d.ts)
  tsconfig.json
  tsconfig.build.json
  package.json

packages/plugin-remote-manifest/src/sub-agent-claude-code/
  plugin.ts              Plugin descriptor export
  worker.ts              Worker entrypoint: calls bootstrap(plugin)
  sub-agent-service.ts   ClaudeCodeSubAgentService — session lifecycle, spawn, RPC
  sandbox.ts             OS sandboxing helpers
  session-recorder.ts    Per-session transcript writer + pruneOldSessions (SOC2 O-8)

packages/plugin-remote-manifest/sandbox/
  macos.sb               macOS sandbox-exec profile (Seatbelt)
  linux-bwrap.sh         Linux bwrap wrapper script
  SMOKE.md               Manual sandbox verification steps
```

## Key exports / surface

**`dist/plugin.js` (main entry `"."`):**
- `plugin` — the `Plugin` descriptor object. `mode: "remote"`, registers `ClaudeCodeSubAgentService`.
- `default` — same as `plugin`.

**`dist/worker.js` (export `"./worker"`):**
- Worker entrypoint. Calls `@elizaos/plugin-worker-runtime`'s `bootstrap(plugin)` and enters the announce/dispatch loop.

**Service registered:** `ClaudeCodeSubAgentService`
- `serviceType`: `"sub-agent.claude-code"`
- RPC methods (callable from host via worker-runtime IPC):
  - `createSession(params)` — spawn `claude` CLI subprocess in a sandboxed env; returns `{ sessionId, createdAt, sandbox }`.
  - `sendPrompt({ sessionId, prompt })` — write a prompt line to the subprocess stdin.
  - `getOutput({ sessionId, mode? })` — read buffered stdout lines (`mode: "all"` or `"since-last"`).
  - `terminate({ sessionId })` — SIGTERM the subprocess and finalize the session transcript.
  - `listSessions()` — list active sessions with cwd, model, sandbox type.

**Plugin remote config:**
- `role: "sub-agent"`, `isolation: "isolated-process"` — spawned via `Bun.spawn`, not a Worker thread.
- Network allowlist: `api.anthropic.com` only.
- Host events emitted: `sub-agent.session.created`, `sub-agent.session.terminated`.
- `lifetime: "session"` — torn down when the agent session ends.

## Commands

```bash
bun run --cwd packages/plugin-sub-agent-claude-code build
bun run --cwd packages/plugin-sub-agent-claude-code typecheck
bun run --cwd packages/plugin-sub-agent-claude-code test
bun run --cwd packages/plugin-sub-agent-claude-code lint
bun run --cwd packages/plugin-sub-agent-claude-code lint:fix
bun run --cwd packages/plugin-sub-agent-claude-code clean
```

## Config / env vars

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Available to the worker process via Bun env permissions (`remote.permissions.bun.env`). Cannot be forwarded to the claude subprocess via `extraEnv` — `filterEnv` throws for keys matching `SENSITIVE_ENV_RE` (`API_KEY` pattern matches). |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Available to the worker process via Bun env permissions. Cannot be forwarded via `extraEnv` — `TOKEN` pattern matches `SENSITIVE_ENV_RE`. |
| `ELIZA_WORKSPACE_DIR` | — | Workspace root for `cwd` validation. Falls back to `ELIZA_STATE_DIR`, then `process.cwd()`. |
| `ELIZA_STATE_DIR` | — | State dir; used as workspace root fallback. |
| `ELIZA_SUB_AGENT_SESSIONS_DIR` | `~/.eliza/sub-agent-sessions` | Directory for per-session transcript logs. |
| `ELIZA_SUB_AGENT_SESSION_RETENTION_DAYS` | `30` | Days before transcript directories are pruned. |

`ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are granted to the worker process via `remote.permissions.bun.env` in `plugin.ts`, so the worker itself can read them from `process.env`. They cannot be forwarded to the claude subprocess via `params.extraEnv` — `filterEnv` throws when any `extraEnv` key matches `SENSITIVE_ENV_RE` (`/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|DATABASE_URL|WALLET|PRIVATE|MNEMONIC|API_KEY)/i`), and both keys match. Only non-sensitive keys (e.g. `ANTHROPIC_BASE_URL`) may be passed via `extraEnv`.

## How to extend

**Add a new RPC method:**
1. Add the method to `ClaudeCodeSubAgentService` in `src/sub-agent-service.ts`.
2. Add its name to `ClaudeCodeSubAgentService.rpcMethods` (the `as const` tuple).
3. The worker-runtime dispatch loop will route calls to it automatically.

**Change sandbox permissions (macOS):**
Edit `packages/plugin-remote-manifest/sandbox/macos.sb` (Seatbelt profile). Key parameters passed by `buildSandboxedCommand`: `WORKSPACE`, `SESSION`, `HOME`, `TMPDIR`. Run the smoke tests in `packages/plugin-remote-manifest/sandbox/SMOKE.md` after changes.

**Change sandbox permissions (Linux):**
Edit `packages/plugin-remote-manifest/sandbox/linux-bwrap.sh`. The script receives `workspaceRoot` and `sessionId` as positional args before `--`.

**Add a new whitelisted binary directory:**
Add the absolute path to `BINARY_DIR_ALLOWLIST` in `src/sandbox.ts`.

## Conventions / gotchas

- **No `@elizaos/core` dep.** The Plugin shape is intentionally loosely typed to avoid pulling the full core dep tree into the worker process. The worker-runtime validates structurally.
- **`cwd` must be absolute and under a workspace root or `/tmp`.** Symlink escapes are rejected via `realpathSync`. Pass absolute paths; relative paths throw `SubAgentCwdError`.
- **Binary resolution uses a static whitelist.** The `claude` binary must be in one of the dirs in `BINARY_DIR_ALLOWLIST` (`/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`). Paths outside the list throw `SubAgentBinaryError`.
- **Missing sandbox helper is a WARN, not an error.** Dev boxes without `bwrap` or `sandbox-exec` still spawn processes with env-allowlist-only. Production deploys should treat this WARN as a P1 fix.
- **Session transcripts are redacted before write.** `SessionRecorder` strips common credential patterns (API keys, GH tokens, Slack tokens, ETH/BTC addresses, card numbers) before flushing to disk. This is a coarse pass; combine with workspace isolation.
- **`pruneOldSessions` is fire-and-forget.** Called at service start; errors are silently swallowed (non-critical cleanup).
- **Stdout is pumped asynchronously.** `pumpStdout` runs in the background; `getOutput` reads from the in-memory buffer, not directly from the stream.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
