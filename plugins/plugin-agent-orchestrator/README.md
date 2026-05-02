# @elizaos/plugin-agent-orchestrator

Orchestrate CLI task agents (Claude Code, Codex, Gemini CLI, Aider, Pi) via PTY sessions and git workspaces for open-ended background work.

Built for [Eliza](https://github.com/eliza-ai/eliza). The plugin registers elizaOS-compatible actions and services so any Eliza agent can delegate substantial work to sub-agents while continuing the user conversation. The full experience, including live xterm views, PTY output streaming, and swarm monitoring, is available through the Eliza frontend and server.

## Features

- **Open-ended task delegation**: Use task agents for anything beyond a simple reply, including coding, research, drafting, debugging, repo work, and multi-step execution
- **PTY session management**: Spawn, control, and monitor task agents running in pseudo-terminals
- **Current task status**: Surface active sessions, coordinator task state, and pending confirmations so the main agent can keep the user updated
- **Subscription-aware framework preference**: Prefer Claude Code or Codex when Eliza knows the user is logged in with Anthropic or OpenAI-backed subscriptions
- **Git workspace provisioning**: Clone repos, create worktrees, manage branches, commits, pushes, and pull requests
- **Multi-agent support**: Claude Code, Codex, Gemini CLI, Aider, Pi, or generic shell flows through the same orchestration surface

## Prerequisites

This plugin spawns CLI task agents in PTY sessions. You need at least one supported framework installed locally:

| Framework | Install | Docs |
|-----------|---------|------|
| **Claude Code** | `npm install -g @anthropic-ai/claude-code` | [claude.ai/claude-code](https://claude.ai/claude-code) |
| **Codex** | `npm install -g @openai/codex` | [github.com/openai/codex](https://github.com/openai/codex) |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| **Aider** | `pip install aider-chat` | [aider.chat](https://aider.chat) |
| **Pi** | install the `pi` CLI available on your host | provider-specific |

Each framework also needs its own auth. API keys still work, but the orchestrator can also detect subscription-backed CLI logins:

- `ANTHROPIC_API_KEY` or a Claude Code subscription login for Claude Code
- `OPENAI_API_KEY` or a Codex login for Codex
- `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY` for Gemini CLI

The provider surface exposes the currently available frameworks and the preferred default. If the user does not specify a framework, the plugin picks the best available option automatically.

## Installation

```bash
npm install @elizaos/plugin-agent-orchestrator
```

The following peer dependencies will be installed automatically:

- `pty-manager` — PTY session management
- `git-workspace-service` — git workspace provisioning
- `coding-agent-adapters` — CLI agent adapter layer

## Usage

### Register the Plugin

```typescript
import taskAgentPlugin from "@elizaos/plugin-agent-orchestrator";

// Add to your Eliza or elizaOS agent configuration
const agent = {
  plugins: [taskAgentPlugin],
  // ... other config
};
```

`codingAgentPlugin` is still exported as a compatibility alias, but `taskAgentPlugin` is the canonical export.

### Canonical Actions

| Action | Description |
|--------|-------------|
| `CREATE_TASK` | Create an asynchronous task-agent job for substantial work |
| `SPAWN_AGENT` | Spawn a task agent session immediately |
| `SEND_TO_AGENT` | Send input or keys to a running task agent |
| `LIST_AGENTS` | List active sessions and current task status |
| `STOP_AGENT` | Terminate an agent session |
| `PROVISION_WORKSPACE` | Clone a repo or create a worktree |
| `FINALIZE_WORKSPACE` | Commit, push, and optionally create PR |

Legacy action names such as `START_CODING_TASK`, `SPAWN_CODING_AGENT`, `SEND_TO_CODING_AGENT`, `LIST_CODING_AGENTS`, and `STOP_CODING_AGENT` remain supported as aliases.

### Example Conversation

```
User: This is bigger than a simple reply. Create a background task to inspect the repo, fix the auth bug, and open a PR.
Agent: Starting a task agent for the repo work...
       Session ID: abc123, Status: running

User: What task agents are running?
Agent: Active task agents:
       1. Claude Code (abc123...) - running
          Working in: /workspace

User: Tell it to accept the changes
Agent: Sent "y" to the task agent.

User: Create a PR for the fix
Agent: Workspace finalized!
       Commit: a1b2c3d4
       PR #42: https://github.com/user/repo/pull/42
```

## Services

### PTYService

Manages PTY sessions for task agents.

```typescript
import { PTYService } from "@elizaos/plugin-agent-orchestrator";

// Access via runtime
const ptyService = runtime.getService("PTY_SERVICE") as PTYService;

// Spawn a session
const session = await ptyService.spawnSession({
  agentType: "claude",
  workdir: "/path/to/project",
  initialTask: "Fix the auth bug",
});

// Send input
await ptyService.sendToSession(session.id, "y");

// Check status
const info = ptyService.getSession(session.id);
console.log(info.status); // "running" | "blocked" | "completed"

// Stop session
await ptyService.stopSession(session.id);
```

### CodingWorkspaceService

Manages git workspaces for task-agent jobs.

```typescript
import { CodingWorkspaceService } from "@elizaos/plugin-agent-orchestrator";

// Access via runtime
const workspaceService = runtime.getService("CODING_WORKSPACE_SERVICE");

// Clone a repo
const workspace = await workspaceService.provisionWorkspace({
  repoUrl: "https://github.com/user/repo.git",
  branch: "feature/my-feature",
});

// Create worktree for parallel work
const worktree = await workspaceService.provisionWorkspace({
  useWorktree: true,
  parentWorkspaceId: workspace.id,
  branch: "bugfix/issue-123",
});

// Commit and push
await workspaceService.commit(workspace.id, {
  message: "fix: resolve auth issue",
  all: true,
});
await workspaceService.push(workspace.id, { setUpstream: true });

// Create PR
const pr = await workspaceService.createPR(workspace.id, {
  title: "Fix auth issue",
  body: "Resolves #123",
});
```

## Configuration

Configure via runtime settings and Eliza config:

```typescript
// PTY Service config
runtime.setSetting("PTY_SERVICE_CONFIG", {
  maxSessions: 5,
  idleTimeoutMs: 30 * 60 * 1000,
  debug: true,
});

// Workspace Service config
runtime.setSetting("CODING_WORKSPACE_CONFIG", {
  baseDir: "~/.eliza/workspaces",
  credentials: {
    github: { token: process.env.GITHUB_TOKEN },
  },
  debug: true,
});

// Optional fixed default when you do not want auto-selection
runtime.setSetting("PARALLAX_DEFAULT_AGENT_TYPE", "codex");

// Selection strategy: "heuristic" | "fixed"
runtime.setSetting("PARALLAX_AGENT_SELECTION_STRATEGY", "heuristic");
```

To bias the preferred framework toward the user's paid subscription, Eliza can store a provider hint in `~/.eliza/eliza.json`:

```json
{
  "agents": {
    "defaults": {
      "subscriptionProvider": "anthropic-subscription"
    }
  }
}
```

Supported subscription hints currently include Anthropic and OpenAI-backed flows, which map to Claude Code and Codex when those CLIs are installed and authenticated.

## Testing

Run the standard suite:

```bash
bun test
```

Run the opt-in live smoke tests against real Claude Code and Codex sessions:

```bash
bun run test:live
```

The live suite creates temporary workspaces, asks the real CLIs to complete small file-writing and browser-backed tasks, and verifies both task execution and task-status visibility. It also has Claude Code and Codex create a simple counter app, emit `APP_CREATE_DONE`, pass parent-side typecheck/lint/test verification, and register the generated app through the unified `APP` `load_from_directory` mode. Set `ELIZA_LIVE_CODEX_MODEL` or `ELIZA_LIVE_CLAUDE_MODEL` to pin a live-test model when needed. If Codex reports that its configured model requires a newer CLI, the counter-app smoke attempts one `npm install -g --prefix <active-codex-prefix> @openai/codex@latest` update through the npm binary colocated with `codex`, then retries once. If Claude Code reports logged-in status but `claude -p` returns 401, the smoke emits `AUTH_REQUIRED` with a `claude setup-token` instruction instead of surfacing a raw provider failure.

## Dependencies

- `pty-manager` - PTY session management with stall detection and auto-response
- `coding-agent-adapters` - Adapter layer for Claude Code, Codex, Gemini CLI, Aider CLIs
- `git-workspace-service` - Git workspace provisioning, credential management, and PR creation
- `pty-console` - Terminal bridge for xterm.js frontend integration

## License

MIT
