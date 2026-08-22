# @elizaos/plugin-coding-tools

Native coding tools for elizaOS agents. Adds focused read/write/edit actions, filesystem search and listing, shell command execution, and git worktree management to any Eliza agent running in a code or terminal context.

## What it does

The plugin registers three focused file actions, three umbrella actions, and a set of supporting services:

| Action | Operations | Description |
|---|---|---|
| **READ / WRITE / EDIT** | one operation each | Pi-shaped strict schemas for direct coding loops. They reuse FILE's sandbox, stale-file, secret, and size guards. |
| **FILE** | `read`, `write`, `edit`, `grep`, `glob`, `ls` | All file and search operations. Relative read/write/edit paths resolve against the conversation's session cwd before sandbox validation. Optional `target=device` routes through a device filesystem bridge for mobile. |
| **SHELL** | `run`, `start_background`, `poll_background`, `write_background`, `kill_background`, `list_background`, `clear_history`, `view_history` | `run` executes a command via `/bin/bash -c` with a per-call timeout (clamped to `[100, 600000]` ms, default 120000). Background actions return stable per-conversation handles, poll incremental stdout/stderr offsets with truncation markers, write stdin, terminate process groups, and list sessions. `view_history`/`clear_history` read or clear per-conversation command history. |
| **WORKTREE** | `enter`, `exit` | Creates and tears down git worktrees, updating the agent's session cwd and sandbox roots automatically. |

Supporting services (automatically started):

- **SandboxService** — path policy engine for FILE, WORKTREE, and the SHELL working directory. Blocks user-private and OS-system paths by default; optionally constrains those validated paths to configured workspace roots. It does not confine paths referenced by a shell command.
- **FileStateService** — tracks file mtimes per conversation so write/edit operations are rejected if the file was externally modified since the agent last read it.
- **SessionCwdService** — per-conversation working directory used by relative file operations and default-path tools. Defaults to `process.cwd()`; updated by WORKTREE operations.
- **BackgroundShellService** — owns per-conversation background shell sessions and reaps all child process groups on plugin teardown.
- **ShellService / ExecApprovalService** (`src/shell/`) — core shell executor with session tracking, plus command-approval gating via a file-backed allowlist; formerly the standalone `@elizaos/plugin-shell`, folded in here along with the `SHELL_HISTORY` provider.
- **RipgrepService** — wraps the `@vscode/ripgrep` binary for fast regex search.

## Enabling the plugin

The plugin is **opt-in**. Enable it by setting `features.codingTools` in the agent configuration:

```json
{
  "features": {
    "codingTools": true
  }
}
```

The legacy key `features["coding-agent"]` is also accepted.

The plugin is automatically disabled when:
- `ELIZA_BUILD_VARIANT=store`
- Running on iOS
- Running on Android without `ELIZA_RUNTIME_MODE=local-yolo`

## Configuration

All settings are optional. Configure via environment variables or agent settings:

| Setting | Default | Description |
|---|---|---|
| `CODING_TOOLS_WORKSPACE_ROOTS` | `process.cwd()` | Comma-separated absolute roots for FILE and WORKTREE paths and the SHELL working directory. This does not restrict paths that a SHELL command reads or writes. |
| `CODING_TOOLS_BLOCKED_PATHS` | (built-in) | Comma-separated absolute paths to block — replaces the default blocklist. |
| `CODING_TOOLS_BLOCKED_PATHS_ADD` | — | Paths to add to the default blocklist. |
| `CODING_TOOLS_SHELL_TIMEOUT_MS` | `120000` | Optional canonical decimal integer from `100` through `600000` used as the default SHELL timeout (ms); invalid values fail before execution and per-call `timeout` takes precedence within the same range. |
| `ELIZA_SHELL_ECHO_TRANSCRIPT` | unset | Set to `1` or `true` to emit the sanitized foreground shell transcript callback before the planner reply. |
| `CODING_TOOLS_BACKGROUND_SHELL_BUFFER_CHARS` | `64000` | Per-stream retained stdout/stderr ring size for background shell polling. |
| `CODING_TOOLS_BACKGROUND_SHELL_KILL_GRACE_MS` | `1500` | Grace period between SIGTERM and SIGKILL for background shell termination. |
| `CODING_TOOLS_MAX_READ_LINES` | `2000` | Max lines returned by FILE action=read. |
| `CODING_TOOLS_MAX_FILE_SIZE_BYTES` | `262144` | Selected-content byte cap. Larger files require an explicit line `limit` (and optional `offset`) and are scanned with bounded memory. |
| `CODING_TOOLS_GREP_HEAD_LIMIT` | `250` | Max output lines for GREP. Set to 0 to disable. |

### SHELL trust boundary

SHELL is an owner-only trusted command executor, not an OS filesystem sandbox.
`CODING_TOOLS_WORKSPACE_ROOTS` validates where a command starts, but an
arbitrary shell command can still address paths outside those roots. Deploy the
plugin only where the OWNER role and host/container boundary are trusted for
that access. Static command analysis and the command denylist are safety checks,
not filesystem confinement.

The folded `ShellService` retains these compatibility settings for external
callers of `runtime.getService("shell").exec()` / `executeCommand()`; the
canonical SHELL action continues to use the `CODING_TOOLS_*` settings above.

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

## Default path blocklist

The following paths are blocked by default (plus platform-specific system directories):

- `~/pvt`, `~/Library`
- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.netrc`

`/dev/{zero,random,urandom,stdin,stdout,stderr}`, `/dev/fd/*`, and the Linux
per-process descriptor entries `/proc/<pid>/{fd,root,cwd,exe,map_files}` — in
their numeric-pid, `self`, `thread-self`, and `/proc/<pid>/task/<tid>` forms —
are unconditional pseudo-path exclusions, including symlink aliases. Other
`/proc` entries such as `fdinfo`, `status`, and `cpuinfo` are not excluded.
`CODING_TOOLS_BLOCKED_PATHS` replaces the configurable default list; it does
not disable those exclusions. Use `CODING_TOOLS_BLOCKED_PATHS_ADD` to extend
the configurable list.

## Requirements

- Node.js runtime only (`eliza.platforms: ["node"]`).
- FILE and WORKTREE require `roleGate: minRole=ADMIN`; SHELL requires `roleGate: minRole=OWNER`.
- All actions are restricted to `contexts: ["code", "terminal", "automation"]`.
