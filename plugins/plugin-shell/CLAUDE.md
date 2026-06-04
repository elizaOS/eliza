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

Only scripts that exist in `package.json`:

```bash
bun run --cwd plugins/plugin-shell build          # bun build → dist/
bun run --cwd plugins/plugin-shell dev            # hot-reload build (bun --hot)
bun run --cwd plugins/plugin-shell test           # vitest run
bun run --cwd plugins/plugin-shell typecheck      # tsgo --noEmit
bun run --cwd plugins/plugin-shell lint           # biome check
bun run --cwd plugins/plugin-shell clean          # rm -rf dist .turbo
bun run --cwd plugins/plugin-shell format         # biome format --write
bun run --cwd plugins/plugin-shell format:check   # biome format (check only)
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
