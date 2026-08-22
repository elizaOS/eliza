# @elizaos/plugin-coding-tools

Native coding tools (READ, WRITE, EDIT, FILE, SHELL, WORKTREE) for Eliza agents running in code/terminal/automation contexts.

## Purpose / role

Adds filesystem operations, shell command execution, and git worktree management to an Eliza agent. The plugin is **opt-in**: it auto-enables when `config.features.codingTools` (or legacy `config.features["coding-agent"]`) is truthy and the runtime environment supports a terminal (disabled on `ELIZA_BUILD_VARIANT=store` and on iOS; Android only when `ELIZA_RUNTIME_MODE=local-yolo`). All actions are gated to `contexts: ["code", "terminal", "automation"]`. FILE and WORKTREE require `roleGate: minRole=ADMIN`; SHELL requires `roleGate: minRole=OWNER`.

## Plugin surface

### Actions

- **FILE** — umbrella for `read/write/edit/grep/glob/ls`. Dispatches to per-operation handlers. Relative `file_path` values for read/write/edit resolve against the conversation's `SessionCwdService` cwd before sandbox validation. Supports `target=device` for `read/write/ls` through a `device_filesystem` bridge service (mobile). Similes: `FILE_OPERATION`, `FILE_IO`.
- **READ / WRITE / EDIT** — strict, operation-specific schemas for direct coding loops. They delegate to the same FILE handlers and preserve its sandbox, stale-file, secret, and size checks.
- **SHELL** — `action=run` executes a command via `/bin/bash -c`; oversized foreground results return an opaque handle whose complete redacted stdout/stderr can be paged with `read_output_artifact` only by the same agent and conversation; `action=start_background` starts a per-conversation background process and returns a stable handle; `poll_background` reads incremental stdout/stderr by absolute stream offsets and reports `truncatedBefore`; `write_background` writes stdin; `kill_background` terminates the process group with SIGTERM then SIGKILL escalation; `list_background` lists sessions; `action=view_history`/`clear_history` read or clear per-conversation command history (backed by the in-plugin `ShellService` (`serviceType = "shell"`)). Per-call `timeout` (ms) is clamped to `[100, 600000]`, default `CODING_TOOLS_SHELL_TIMEOUT_MS` (120000). Similes: `BASH`, `EXEC`, `RUN_COMMAND`.
- **WORKTREE** — umbrella for `enter/exit` git worktrees. On enter, registers new root in `SandboxService` and pushes to `SessionCwdService` stack. On exit, pops. Similes: `GIT_WORKTREE`.

### Providers

- **SHELL_HISTORY** (`src/shell/providers/shellHistoryProvider.ts`, position `99`) — injects a bounded projection of the last 10 commands (size-capped stdout/stderr/exit code), cwd, allowed directory, and recent file operations into context while `ShellService` retains complete history; fires only in `terminal`/`code` contexts.
- **AVAILABLE_CODING_TOOLS** — injects the available focused and umbrella tool names (`READ`, `WRITE`, `EDIT`, `FILE`, `SHELL`, `WORKTREE`) into agent state at position `-10`. Stable/agent-scoped cache.

### Services

| Service | `serviceType` constant | Purpose |
|---|---|---|
| `ShellService` | `"shell"` | Core shell executor (formerly @elizaos/plugin-shell): `executeCommand()` (simple), `exec()` (PTY, background, yield, session tracking), `processAction()` session management. Lives in `src/shell/`. |
| `ExecApprovalService` | `"exec_approval"` | Command approval gating: file-backed allowlist, routes unapproved commands through the elizaOS `ApprovalService` UI. Lives in `src/shell/approvals/`. |
| `SandboxService` | `CODING_TOOLS_SANDBOX` | Path-blocklist policy for FILE, WORKTREE, and the SHELL working directory. Defaults block `~/pvt`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/Library`, plus per-OS system paths. Optional allow-roots via `CODING_TOOLS_WORKSPACE_ROOTS`; these do not confine paths referenced by a shell command. |
| `FileStateService` | `CODING_TOOLS_FILE_STATE` | Per-(conversation, file) mtime tracking. Write/Edit check that the file was not externally modified since the last Read. |
| `SessionCwdService` | `CODING_TOOLS_SESSION_CWD` | Per-conversation working directory. Defaults to `process.cwd()`. Read/Write/Edit resolve relative paths against it; Glob/Grep/LS/Shell use it when no explicit `path`/`cwd` is given. Worktree push/pop mutates it. |
| `BackgroundShellService` | `CODING_TOOLS_BACKGROUND_SHELL` | Per-conversation background shell process manager. Owns stable handles, stdin writes, bounded stdout/stderr rings, SIGTERM→SIGKILL termination, and teardown reaping. |
| `RipgrepService` | `CODING_TOOLS_RIPGREP` | Wraps `@vscode/ripgrep` binary. Used by `grep` operation. Always excludes VCS dirs. 30 s hard cap. |

### Other exports

- `coding-agent-context` (Zod schemas) — `FileOperationSchema`, `CommandResultSchema`, `CapturedErrorSchema`, etc. Used to validate structured outputs from coding loops.

## Layout

```
plugins/plugin-coding-tools/
  src/
    index.ts                      Plugin entry — exports codingToolsPlugin, all services, types
    types.ts                      Service-type constants, ToolFailure/ToolResult types, CODING_TOOLS_CONTEXTS
    actions/
      file.ts                     FILE umbrella action — routes to per-op handlers
      direct-file-actions.ts      strict READ / WRITE / EDIT action wrappers
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
      background-shell-service.ts Per-conversation background shell sessions
      ripgrep-service.ts          @vscode/ripgrep wrapper
      coding-agent-context.ts     Zod schemas for coding-agent context types
      index.ts                    Re-exports all services
    lib/
      format.ts                   Param readers (readStringParam, readNumberParam), successActionResult, failureToActionResult
      path-utils.ts               Path predicates plus FILE input resolution against the session cwd
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
| `CODING_TOOLS_WORKSPACE_ROOTS` | `process.cwd()` | Comma-separated absolute roots for FILE and WORKTREE paths and the SHELL working directory. This does not restrict paths that a SHELL command reads or writes. |
| `CODING_TOOLS_BLOCKED_PATHS` | (built-in list) | Comma-separated absolute paths — **replaces** the configurable default blocklist; unconditional device and process/thread descriptor exclusions remain enforced. |
| `CODING_TOOLS_BLOCKED_PATHS_ADD` | — | Comma-separated paths to **add** to the default blocklist. |
| `CODING_TOOLS_SHELL` | (auto-detected) | Override the shell binary used by SHELL action. Takes priority over `SHELL`. Useful on Android/AOSP where the default shell path may not be executable. |
| `CODING_TOOLS_SHELL_TIMEOUT_MS` | `120000` | Optional canonical decimal integer from `100` through `600000` used as the default SHELL timeout (ms); invalid values fail before execution and per-call `timeout` takes precedence within the same range. |
| `CODING_TOOLS_BACKGROUND_SHELL_BUFFER_CHARS` | `64000` | Per-stream retained stdout/stderr ring size for background shell polling. |
| `CODING_TOOLS_BACKGROUND_SHELL_KILL_GRACE_MS` | `1500` | Grace period between SIGTERM and SIGKILL for background shell termination. |
| `CODING_TOOLS_MAX_READ_LINES` | `2000` | Max lines returned by FILE action=read before truncation. |
| `CODING_TOOLS_MAX_FILE_SIZE_BYTES` | `262144` | Byte cap for selected FILE read content. Larger files are paged with bounded line or byte reads. |
| `CODING_TOOLS_GREP_HEAD_LIMIT` | `250` | Default `head_limit` for GREP output. Set to 0 to disable. |

The folded `ShellService` also retains compatibility settings for external
consumers of `runtime.getService("shell").exec()` / `executeCommand()`. The
canonical SHELL action above continues to use the `CODING_TOOLS_*` settings.

| Compatibility setting | Default | Accepted values / effect |
|---|---:|---|
| `SHELL_ALLOWED_DIRECTORY` | `process.cwd()` | Existing directory exposed to the compatibility service. |
| `SHELL_TIMEOUT` | `30000` | Exact decimal milliseconds, `1..2147483647`, for simple command execution. |
| `SHELL_MAX_OUTPUT_CHARS` | `200000` | Exact decimal retained-session cap, `1..1000000`. |
| `SHELL_PENDING_MAX_OUTPUT_CHARS` | `200000` | Exact decimal unread-output cap, `1..1000000` (also bounded by the retained-session cap). |
| `SHELL_BACKGROUND_MS` | `10000` | Exact decimal foreground yield window, `10..120000`. |
| `SHELL_JOB_TTL_MS` | `1800000` | Exact decimal finished-session retention window, `60000..10800000`. |
| `SHELL_ALLOW_BACKGROUND` | `true` | Set to exact `false` to disable compatibility-service background/yield behavior. |
| `SHELL_FORBIDDEN_COMMANDS` | — | Comma-separated additions to the built-in forbidden-command set. |

Foreground SHELL transcripts shown to the planner are capped at 50,000
characters. When that cap is reached, the action writes the complete redacted
stdout and stderr plus a manifest under
`ELIZA_STATE_DIR/coding-tools/shell-output/<handle>/`, returns the handle and
byte/line counts, and leaves the bounded preview in the tool result. The action
does not disclose state-root paths. `action=read_output_artifact` retrieves a
bounded stdout or stderr page only when the opaque handle's persisted agent and
conversation scope match the requesting turn. Artifact directories are
owner-only (`0700`) and files are `0600`. They use
`SHELL_JOB_TTL_MS` (30 minutes by default) and expired handles are removed
opportunistically when the next truncated foreground result is persisted.

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

- **READ/WRITE/EDIT paths may be absolute or relative.** Relative paths resolve against `SessionCwdService.getCwd(message.roomId)`; the resolved absolute path must still pass `SandboxService.validatePath`. A missing session-cwd service is an explicit failure.
- **Always validate paths through `SandboxService.validatePath`** before any filesystem access. Never bypass this.
- **SHELL is trusted host execution, not filesystem confinement.** `CODING_TOOLS_WORKSPACE_ROOTS` validates SHELL's `cwd` only. Commands may address paths outside those roots, so the OWNER role and deployment host/container boundary must be trusted.
- **Read before write**: `FileStateService.assertWritable` will reject a write if the file was modified externally since the last read. The agent must re-read first.
- **`conversationId` = `message.roomId`** (string-coerced). Missing `roomId` is a hard failure.
- **Never throw from a handler** — return `failureToActionResult({ reason, message })` instead.
- The `@vscode/ripgrep` binary is resolved at `RipgrepService` start time; if that import fails it falls back to a system `rg` on `PATH`.
- The `device_filesystem` bridge (`target=device` on FILE) is provided by a separate service (`device_filesystem` service type) registered by a platform plugin (e.g. mobile). The coding-tools plugin does not register it — it only consumes it when present.
- Tests are co-located `*.test.ts` files beside their source in `src/actions/`, `src/services/`, and `src/lib/`. Integration tests live in `__tests__/plugin-integration.test.ts` at the package root. See `AGENT_CONTRACT.md` for the action implementation brief.
- Import paths must use the `.js` extension on relative imports (ESM requirement).

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.
