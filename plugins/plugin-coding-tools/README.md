# @elizaos/plugin-coding-tools

Native Claude-Code-style coding tools for elizaOS agents. Adds filesystem operations (read, write, edit, search, glob, ls), shell command execution, and git worktree management to any Eliza agent running in a code or terminal context.

## What it does

The plugin registers three umbrella actions and a set of supporting services:

| Action | Operations | Description |
|---|---|---|
| **FILE** | `read`, `write`, `edit`, `grep`, `glob`, `ls` | All file and search operations. Paths must be absolute. Optional `target=device` routes through a device filesystem bridge for mobile. |
| **SHELL** | `run`, `clear_history`, `view_history` | Runs local shell commands with a configurable timeout. Long-running commands auto-background and return a `task_id`. Built-in and user-configurable command denylist. |
| **WORKTREE** | `enter`, `exit` | Creates and tears down git worktrees, updating the agent's session cwd and sandbox roots automatically. |

Supporting services (automatically started):

- **SandboxService** — path policy engine. Blocks user-private and OS-system paths by default; optionally constrains access to configured workspace roots.
- **FileStateService** — tracks file mtimes per conversation so write/edit operations are rejected if the file was externally modified since the agent last read it.
- **SessionCwdService** — per-conversation working directory. Defaults to `process.cwd()`; updated by WORKTREE operations.
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
| `CODING_TOOLS_WORKSPACE_ROOTS` | `process.cwd()` | Comma-separated absolute paths the tools may access. Files outside these roots are rejected. |
| `CODING_TOOLS_BLOCKED_PATHS` | (built-in) | Comma-separated absolute paths to block — replaces the default blocklist. |
| `CODING_TOOLS_BLOCKED_PATHS_ADD` | — | Paths to add to the default blocklist. |
| `CODING_TOOLS_DENY_COMMANDS` | — | Comma-separated command prefixes SHELL must refuse (combined with built-in denylist). |
| `CODING_TOOLS_SHELL_TIMEOUT_MS` | `120000` | Hard timeout for shell commands (ms). |
| `CODING_TOOLS_SHELL_BG_BUDGET_MS` | `15000` | Commands running longer than this auto-background (ms). |
| `CODING_TOOLS_MAX_READ_LINES` | `2000` | Max lines returned by FILE action=read. |
| `CODING_TOOLS_MAX_FILE_SIZE_BYTES` | `262144` | File size cap for reads (bytes). Larger files are rejected. |
| `CODING_TOOLS_GREP_HEAD_LIMIT` | `250` | Max output lines for GREP. Set to 0 to disable. |

## Default path blocklist

The following paths are blocked by default (plus platform-specific system directories):

- `~/pvt`, `~/Library`
- `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.kube`, `~/.netrc`

Override with `CODING_TOOLS_BLOCKED_PATHS` (replace) or `CODING_TOOLS_BLOCKED_PATHS_ADD` (extend).

## Requirements

- Node.js runtime only (`eliza.platforms: ["node"]`).
- Actions require `roleGate: minRole=ADMIN` — the calling user or agent must have ADMIN role.
- All actions are restricted to `contexts: ["code", "terminal", "automation"]`.

## License

MIT
