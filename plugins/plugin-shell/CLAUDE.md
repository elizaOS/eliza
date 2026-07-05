# @elizaos/plugin-shell

Shell command execution, PTY support, background session management, and command approval for Eliza agents.

## Purpose / role

Adds shell-execution capability to an Eliza agent: run system commands within a sandboxed directory, track running processes as named sessions, and stream output. Loaded as `@elizaos/plugin-shell`. Auto-enabled when `config.features.shell` is truthy and the runtime platform supports a terminal (disabled for iOS, store builds; Android requires `local-yolo` mode). See `auto-enable.ts` and `index.ts → autoEnable.shouldEnable`.

## Plugin surface

**Services** (registered in `Plugin.services`):

- `ShellService` (`serviceType = "shell"`) — core executor. Run commands via `executeCommand()` (simple) or `exec()` (PTY, background, yield, session tracking). Manage sessions via `processAction()`. Retrieve via `runtime.getService<ShellService>("shell")`.
- `ExecApprovalService` (`serviceType = "exec_approval"`) — command approval gating. Maintains an allowlist file; routes unapproved commands through the elizaOS `ApprovalService` UI. Retrieve via `runtime.getService<ExecApprovalService>("exec_approval")`.

**Providers** (registered in `Plugin.providers`):

- `shellHistoryProvider` (`name = "SHELL_HISTORY"`, `position = 99`) — injects the last 10 commands (with stdout/stderr/exit code), current working directory, allowed directory, and recent file operations into context. Only fires in `terminal` or `code` contexts.

**Actions:** none — this plugin registers no actions. The agent-facing `SHELL` action lives in `@elizaos/plugin-coding-tools` (`src/actions/bash.ts`), which consumes `ShellService`; its `action` parameter (e.g. `list`, `poll`, `kill`) maps to `ShellService.processAction()` for process management.

**Evaluators / Routes / Events:** none.

## Layout

```
plugins/plugin-shell/
├── index.ts                    # Plugin object export; auto-enable logic
├── auto-enable.ts              # Lightweight shouldEnable() for the auto-enable engine
├── types/
│   └── index.ts                # All shared types: ShellConfig, ProcessSession,
│                               #   FinishedSession, ExecResult, ExecuteOptions, etc.
├── services/
│   ├── shellService.ts         # ShellService — executeCommand(), exec(), processAction()
│   └── processRegistry.ts     # Module-level process registry (running/finished sessions)
├── providers/
│   └── shellHistoryProvider.ts # SHELL_HISTORY provider
├── approvals/
│   ├── service.ts              # ExecApprovalService
│   ├── allowlist.ts            # File-backed allowlist CRUD
│   ├── analysis.ts             # Command risk analysis, evaluateShellAllowlist()
│   ├── types.ts                # Approval types and DEFAULT_SAFE_BINS
│   └── index.ts                # Barrel export for the approvals module
├── utils/
│   ├── config.ts               # loadShellConfig() — env → ShellConfig; DEFAULT_FORBIDDEN_COMMANDS
│   ├── pathUtils.ts            # validatePath() — enforces allowedDirectory boundary
│   ├── shellUtils.ts           # getShellConfig(), spawnWithFallback(), killSession(),
│   │                           #   sanitizeBinaryOutput(), sliceLogLines(), etc.
│   ├── terminalCapabilities.ts # detectTerminalSupport(), resolveTerminalShell(),
│   │                           #   missingTerminalToolForCommand()
│   ├── ptyKeys.ts              # encodeKeySequence(), encodePaste(), stripDsrRequests()
│   ├── shellArgv.ts            # Shell argument parsing helpers
│   └── processQueue.ts         # Async process queue utility
└── prompts.ts                  # commandExtractionTemplate — LLM prompt to extract a shell command from a request
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-shell clean         # remove build output
bun run --cwd plugins/plugin-shell build         # build package artifacts
bun run --cwd plugins/plugin-shell build:ts      # ts build lane
bun run --cwd plugins/plugin-shell dev           # development build/watch lane
bun run --cwd plugins/plugin-shell typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-shell lint          # mutating Biome check
bun run --cwd plugins/plugin-shell lint:check    # read-only Biome check
bun run --cwd plugins/plugin-shell format        # write formatting
bun run --cwd plugins/plugin-shell format:check  # read-only formatting check
bun run --cwd plugins/plugin-shell test          # run package tests
```

## Config / env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `SHELL_ALLOWED_DIRECTORY` | **yes** | `process.cwd()` | All commands restricted to this directory. Must exist. |
| `SHELL_TIMEOUT` | no | `30000` | Per-command timeout (ms) for `executeCommand()`. |
| `SHELL_FORBIDDEN_COMMANDS` | no | — | Comma-separated additional forbidden commands (merged with `DEFAULT_FORBIDDEN_COMMANDS`). |
| `SHELL_MAX_OUTPUT_CHARS` | no | `200000` | Max aggregated output chars captured per session. |
| `SHELL_PENDING_MAX_OUTPUT_CHARS` | no | `200000` | Max pending output buffered per stream. |
| `SHELL_BACKGROUND_MS` | no | `10000` | Default yield window before auto-backgrounding in `exec()`. |
| `SHELL_ALLOW_BACKGROUND` | no | `true` | Set to `"false"` to disable background/yield execution. |
| `SHELL_JOB_TTL_MS` | no | `1800000` | TTL for finished session records (ms). |

Config is validated by zod in `utils/config.ts → loadShellConfig()`. Missing or non-existent `SHELL_ALLOWED_DIRECTORY` throws at service start.

## How to extend

**Add a new process action** — extend the `ProcessAction` union in `types/index.ts`, then add the corresponding `case` in `ShellService.processAction()` in `services/shellService.ts`.

**Add a new util** — place it in `utils/`. Export from `utils/index.ts` and re-export from the top-level `index.ts` if it needs to be part of the public package API.

**Add a new approval rule** — extend `approvals/types.ts` and `approvals/analysis.ts → analyzeShellCommand()`.

**Expose a new provider** — create the provider file in `providers/`, register it in the `Plugin.providers` array in `index.ts`, and add a provider spec in `generated/specs/` (see `shellHistoryProvider.ts → requireProviderSpec`).

## Conventions / gotchas

- **`@lydell/node-pty` is optional** — PTY spawn is wrapped in a dynamic `import()` with a fallback to plain `cross-spawn`. On platforms where native modules are absent, `pty: true` degrades to non-PTY with a warning. Do not add `node-pty` to `dependencies`; keep it in `optionalDependencies`.
- **Cloud mode** — `ShellService.exec()` and `executeCommand()` short-circuit when `isCloudExecutionMode(runtime)` is true. Local shell execution is explicitly disabled in cloud mode.
- **Sandbox mode** — when `shouldUseSandboxExecution(runtime)` is true, commands route through `SandboxManager.exec()` instead of spawning directly. Background/PTY options are silently ignored in sandbox mode.
- **Platform gating** — iOS and `ELIZA_BUILD_VARIANT=store` builds never enable this plugin. Android requires `ELIZA_RUNTIME_MODE=local-yolo`. Check `auto-enable.ts → terminalSupportedByEnv`.
- **processRegistry is module-level** — `services/processRegistry.ts` holds process state in module-scope Maps. In tests, call `resetProcessRegistryForTests()` between cases.
- **No actions here** — the agent-facing `SHELL` action is owned by `@elizaos/plugin-coding-tools`. This plugin only provides the service, approval service, and history provider.
- **`SHELL_ALLOWED_DIRECTORY` must exist** — `loadShellConfig()` calls `fs.statSync()` and throws `ENOENT` if the path does not exist. Set it before the agent starts.

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
