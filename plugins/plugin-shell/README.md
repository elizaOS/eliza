# @elizaos/plugin-shell

Shell command execution plugin for elizaOS. Adds sandboxed shell access, PTY support, background session management, command approval, and shell history to an Eliza agent.

## What it does

- Executes shell commands restricted to a configured directory (`SHELL_ALLOWED_DIRECTORY`).
- Supports interactive terminal applications via PTY (`@lydell/node-pty`, optional).
- Runs long commands in the background with named sessions; poll, send-keys, paste, and kill them later.
- Maintains per-conversation command history with stdout/stderr/exit-code capture.
- Provides the `SHELL_HISTORY` context provider so the agent always knows its cwd and recent commands.
- Provides `ExecApprovalService` to gate commands through an allowlist and user-approval flow.

The agent-facing `SHELL` action that exposes shell execution is in `@elizaos/plugin-coding-tools`, which consumes this plugin's services. Its `action` parameter (list/poll/kill/etc.) drives `ShellService.processAction()`.

## Installation

```bash
bun add @elizaos/plugin-shell
```

## Configuration

```bash
# Required — commands cannot execute outside this directory
SHELL_ALLOWED_DIRECTORY=/path/to/safe/workspace

# Optional
SHELL_TIMEOUT=30000                  # per-command timeout ms (simple executeCommand)
SHELL_FORBIDDEN_COMMANDS=rm,mv       # comma-separated additions to the default blocklist
SHELL_MAX_OUTPUT_CHARS=200000        # max captured output chars per session
SHELL_BACKGROUND_MS=10000            # yield window before auto-backgrounding (ms)
SHELL_ALLOW_BACKGROUND=true          # set "false" to disable background execution
SHELL_JOB_TTL_MS=1800000            # finished session record TTL (ms)
```

`SHELL_ALLOWED_DIRECTORY` must point to an existing directory. The service throws at start if it is missing.

## Enabling

Auto-enabled when `config.features.shell` is truthy. Not available on iOS, `ELIZA_BUILD_VARIANT=store` builds, or Android unless `ELIZA_RUNTIME_MODE=local-yolo`.

To enable explicitly in a character file:

```typescript
import shellPlugin from "@elizaos/plugin-shell";

const character = {
  plugins: [shellPlugin],
};
```

## Security

- All commands execute within `SHELL_ALLOWED_DIRECTORY`. Path traversal and absolute paths outside the boundary are rejected.
- A built-in blocklist prevents the most destructive commands (see `DEFAULT_FORBIDDEN_COMMANDS` in `utils/config.ts`).
- Additional forbidden commands can be added via `SHELL_FORBIDDEN_COMMANDS`.
- Commands time out automatically. Output is capped at `SHELL_MAX_OUTPUT_CHARS`.
- `ExecApprovalService` can gate commands through an allowlist + user approval before execution.
- Local execution is disabled in cloud mode (`isCloudExecutionMode`).

## Process actions

Background sessions support these operations via `ShellService.processAction()`:

| Action | Description |
|---|---|
| `list` | List all running and finished sessions |
| `poll` | Drain new output from a running session |
| `log` | Read session output with offset/limit pagination |
| `write` | Write raw data to session stdin |
| `send-keys` | Send terminal key sequences (arrows, ctrl+c, etc.) |
| `submit` | Send carriage return (Enter) |
| `paste` | Paste text with bracketed paste mode |
| `kill` | Kill a running session |
| `clear` | Remove a finished session record |
| `remove` | Kill (if running) and remove a session |

## Usage from code

```typescript
import { ShellService } from "@elizaos/plugin-shell";

// Simple synchronous execution
const shellService = runtime.getService<ShellService>("shell");
const result = await shellService.executeCommand("ls -la", conversationId);

// Advanced: PTY + background
const execResult = await shellService.exec("bun install", {
  pty: true,
  yieldMs: 5000,   // background after 5 s if still running
  timeout: 300,    // 5-minute hard timeout (seconds)
  workdir: "/project",
});

if (execResult.status === "running") {
  // Poll later
  const poll = await shellService.processAction({
    action: "poll",
    sessionId: execResult.sessionId,
  });
}
```

## Development

```bash
bun run --cwd plugins/plugin-shell build    # build dist/
bun run --cwd plugins/plugin-shell test     # vitest
bun run --cwd plugins/plugin-shell dev      # hot-reload build
```
