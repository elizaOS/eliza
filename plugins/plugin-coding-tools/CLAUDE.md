# @elizaos/plugin-coding-tools

Native Claude-Code-style coding tools (FILE, SHELL, WORKTREE) for Eliza agents running in code/terminal/automation contexts.

## Purpose / role

Adds filesystem operations, shell command execution, and git worktree management to an Eliza agent. The plugin is **opt-in**: it auto-enables when `config.features.codingTools` (or legacy `config.features["coding-agent"]`) is truthy and the runtime environment supports a terminal (disabled on `ELIZA_BUILD_VARIANT=store` and on iOS; Android only when `ELIZA_RUNTIME_MODE=local-yolo`). All actions are gated to `contexts: ["code", "terminal", "automation"]`. FILE and WORKTREE require `roleGate: minRole=ADMIN`; SHELL requires `roleGate: minRole=OWNER`.

## Plugin surface

### Actions

- **FILE** — umbrella for `read/write/edit/grep/glob/ls`. Dispatches to per-operation handlers. Supports `target=device` for `read/write/ls` through a `device_filesystem` bridge service (mobile). Similes: `FILE_OPERATION`, `FILE_IO`.
- **SHELL** — `action=run` executes a command via `/bin/bash -c`; `action=view_history`/`clear_history` read or clear per-conversation command history (backed by an external `shell` service when present). Per-call `timeout` (ms) is clamped to `[100, 600000]`, default `CODING_TOOLS_SHELL_TIMEOUT_MS` (120000). Similes: `BASH`, `EXEC`, `RUN_COMMAND`.
- **WORKTREE** — umbrella for `enter/exit` git worktrees. On enter, registers new root in `SandboxService` and pushes to `SessionCwdService` stack. On exit, pops. Similes: `GIT_WORKTREE`.

### Provider

- **AVAILABLE_CODING_TOOLS** — injects the list of available tool names (`FILE`, `SHELL`, `WORKTREE`) into agent state at position `-10`. Stable/agent-scoped cache.

### Services

| Service | `serviceType` constant | Purpose |
|---|---|---|
| `SandboxService` | `CODING_TOOLS_SANDBOX` | Path-blocklist policy. Validates every path before read/write. Defaults block `~/pvt`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/Library`, plus per-OS system paths. Optional allow-roots via `CODING_TOOLS_WORKSPACE_ROOTS`. |
| `FileStateService` | `CODING_TOOLS_FILE_STATE` | Per-(conversation, file) mtime tracking. Write/Edit check that the file was not externally modified since the last Read. |
| `SessionCwdService` | `CODING_TOOLS_SESSION_CWD` | Per-conversation working directory. Defaults to `process.cwd()`. Glob/Grep/LS/Shell use this when no explicit `path`/`cwd` is given. Worktree push/pop mutates it. |
| `RipgrepService` | `CODING_TOOLS_RIPGREP` | Wraps `@vscode/ripgrep` binary. Used by `grep` operation. Always excludes VCS dirs. 30 s hard cap. |

### Other exports

- `CodingTaskExecutor` — task executor that maps task specs matching coding-related keywords into agent actions. Consumed externally by orchestration plugins.
- `coding-agent-context` (Zod schemas) — `FileOperationSchema`, `CommandResultSchema`, `CapturedErrorSchema`, etc. Used to validate structured outputs from coding loops.

## Layout

```
plugins/plugin-coding-tools/
  src/
    index.ts                      Plugin entry — exports codingToolsPlugin, all services, types
    types.ts                      Service-type constants, ToolFailure/ToolResult types, CODING_TOOLS_CONTEXTS
    actions/
      file.ts                     FILE umbrella action — routes to per-op handlers
      bash.ts                     SHELL action implementation
      worktree.ts                 WORKTREE umbrella action
      read.ts / write.ts / edit.ts  FILE sub-handlers for read/write/edit
      grep.ts / glob.ts / ls.ts   FILE sub-handlers for grep/glob/ls
      enter-worktree.ts / exit-worktree.ts  WORKTREE sub-handlers
      index.ts                    Re-exports all action handlers
    providers/
      available-tools.ts          AVAILABLE_CODING_TOOLS provider
    services/
      sandbox-service.ts          Path policy (blocklist + allow-roots)
      file-state-service.ts       Per-conversation file mtime tracking
      session-cwd-service.ts      Per-conversation working directory + worktree stack
      ripgrep-service.ts          @vscode/ripgrep wrapper
      coding-task-executor.ts     CodingTaskExecutor (external task delegation)
      coding-agent-context.ts     Zod schemas for coding-agent context types
      index.ts                    Re-exports all services
    lib/
      format.ts                   Param readers (readStringParam, readNumberParam), successActionResult, failureToActionResult
      path-utils.ts               isAbsolutePath, isWithin, resolveRealPath, isUncPath
      run-shell.ts                runShell helper (child_process wrapper with timeout/streaming)
      run-git-command.ts          runGitCommand helper
      terminal-capabilities.ts    Platform capability detection
      secrets.ts                  detectSecrets — flags AWS/GitHub/OpenAI/etc. tokens to gate WRITE/EDIT
  auto-enable.ts                  Lightweight auto-enable module (env reads only; no plugin runtime imports)
  AGENT_CONTRACT.md               Implementation brief for action-writing agents
  build.ts                        build script (Bun.build + tsc d.ts emit)
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-coding-tools clean         # remove build output
bun run --cwd plugins/plugin-coding-tools build         # build package artifacts
bun run --cwd plugins/plugin-coding-tools dev           # development build/watch lane
bun run --cwd plugins/plugin-coding-tools typecheck     # TypeScript typecheck
bun run --cwd plugins/plugin-coding-tools check         # package check alias
bun run --cwd plugins/plugin-coding-tools lint          # mutating Biome check
bun run --cwd plugins/plugin-coding-tools lint:check    # read-only Biome check
bun run --cwd plugins/plugin-coding-tools format        # write formatting
bun run --cwd plugins/plugin-coding-tools format:check  # read-only formatting check
bun run --cwd plugins/plugin-coding-tools test          # run package tests
```

## Config / env vars

All settings are read via `runtime.getSetting(key)` or `process.env`. None are required.

| Env var | Default | Description |
|---|---|---|
| `CODING_TOOLS_WORKSPACE_ROOTS` | `process.cwd()` | Comma-separated absolute paths the tools may access. When set, paths outside these roots are rejected. |
| `CODING_TOOLS_BLOCKED_PATHS` | (built-in list) | Comma-separated absolute paths — **replaces** the default blocklist. |
| `CODING_TOOLS_BLOCKED_PATHS_ADD` | — | Comma-separated paths to **add** to the default blocklist. |
| `CODING_TOOLS_SHELL` | (auto-detected) | Override the shell binary used by SHELL action. Takes priority over `SHELL`. Useful on Android/AOSP where the default shell path may not be executable. |
| `CODING_TOOLS_SHELL_TIMEOUT_MS` | `120000` | Default SHELL timeout (ms); per-call `timeout` clamps to `[100, 600000]`. |
| `CODING_TOOLS_MAX_READ_LINES` | `2000` | Max lines returned by FILE action=read before truncation. |
| `CODING_TOOLS_MAX_FILE_SIZE_BYTES` | `262144` | Pre-stat byte cap on FILE action=read. Larger files are rejected. |
| `CODING_TOOLS_GREP_HEAD_LIMIT` | `250` | Default `head_limit` for GREP output. Set to 0 to disable. |

Auto-enable keys (in agent `config.features`):
- `config.features.codingTools` (canonical) — `true` or `{ enabled: true }`.
- `config.features["coding-agent"]` (legacy alias).

Runtime gating env vars (read by `auto-enable.ts` and `index.ts`):
- `ELIZA_BUILD_VARIANT` — if `store`, plugin is disabled.
- `ELIZA_PLATFORM` — `android`/`ios` disables unless local-yolo mode.
- `ELIZA_RUNTIME_MODE` / `RUNTIME_MODE` / `LOCAL_RUNTIME_MODE` — `local-yolo` enables on Android.

## How to extend

### Add a new FILE sub-operation

1. Create `src/actions/<op>.ts` exporting a `<op>Handler` function with the `FileHandler` signature (`(runtime, message, state, options, callback) => Promise<ActionResult>`).
2. Export it from `src/actions/index.ts`.
3. Add the op name to `FILE_OPERATIONS` in `src/actions/file.ts` and wire it into `FILE_ACTIONS`.
4. Validate paths through `SandboxService.validatePath` before any filesystem access.
5. Record reads via `FileStateService.recordRead` and check writability via `FileStateService.assertWritable` before write/edit ops.

### Add a new top-level action

1. Create `src/actions/<action>.ts` exporting a `const <name>Action: Action`.
2. Export from `src/actions/index.ts`.
3. Import and add to the `actions` array in `src/index.ts`.
4. Use `contexts: [...CODING_TOOLS_CONTEXTS]` and `contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] }` so the action only fires in coding contexts.
5. Use `roleGate: { minRole: "ADMIN" }` for FILE/WORKTREE actions, or `roleGate: { minRole: "OWNER" }` for SHELL-equivalent actions — match the role of the existing action you are most similar to.

### Add a new service

1. Extend `Service` from `@elizaos/core`. Implement `static async start(runtime)` and `async stop()`.
2. Assign a string constant as `serviceType` in `src/types.ts`.
3. Export from `src/services/index.ts`.
4. Add to `services` array in `src/index.ts` and handle `stop()` in the `dispose` hook.

## Conventions / gotchas

- **All file paths must be absolute** for READ/WRITE/EDIT operations. GLOB/GREP/LS accept absolute or default to `SessionCwdService.getCwd(message.roomId)`.
- **Always validate paths through `SandboxService.validatePath`** before any filesystem access. Never bypass this.
- **Read before write**: `FileStateService.assertWritable` will reject a write if the file was modified externally since the last read. The agent must re-read first.
- **`conversationId` = `message.roomId`** (string-coerced). Missing `roomId` is a hard failure.
- **Never throw from a handler** — return `failureToActionResult({ reason, message })` instead.
- The `@vscode/ripgrep` binary is resolved at `RipgrepService` start time; if that import fails it falls back to a system `rg` on `PATH`.
- The `device_filesystem` bridge (`target=device` on FILE) is provided by a separate service (`device_filesystem` service type) registered by a platform plugin (e.g. mobile). The coding-tools plugin does not register it — it only consumes it when present.
- Tests are co-located `*.test.ts` files beside their source in `src/actions/`, `src/services/`, and `src/lib/`. Integration tests live in `__tests__/plugin-integration.test.ts` at the package root. See `AGENT_CONTRACT.md` for the action implementation brief.
- Import paths must use the `.js` extension on relative imports (ESM requirement).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
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
