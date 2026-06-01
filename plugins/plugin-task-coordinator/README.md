# @elizaos/plugin-task-coordinator

UI workbench for managing coding-agent task threads and PTY sessions inside elizaOS.

## What it does

This plugin adds two interactive surfaces to the elizaOS dashboard:

**Task Coordinator** — lists active coding-agent sessions and task threads, shows live PTY output from running agents, and lets you stop individual sessions or all sessions at once.

**Orchestrator** — a multi-agent task orchestration workbench. Create task threads with goals and acceptance criteria, assign sub-agents (elizaOS, Claude Code, Codex, OpenCode, Pi Agent), monitor their timeline of events and messages, fork tasks, validate results, and send messages to running tasks — all from one panel.

Both surfaces are available in standard, XR, and TUI (terminal) variants.

The plugin also fills the coding-agent slot components that `@elizaos/ui` exposes as null placeholders:
- A header control chip showing active agent count with a stop-all button.
- The per-framework settings section (model, LLM provider, approval preset, GitHub connection).
- The PTY console (drawer, side-panel, and full-screen variants).

## Capabilities

The Orchestrator panel supports these operations:

| Capability | Description |
|---|---|
| Status | Get current orchestrator status |
| List tasks | List task threads, filter by status, search, include archived |
| Open task | Open a task thread detail view |
| Create task | Create a new task with title, goal, priority, acceptance criteria |
| Pause / resume task | Pause or resume a single task |
| Pause all / resume all | Bulk pause or resume |
| Delete task | Remove a task thread |
| Fork task | Fork an existing task with a new title/goal/priority |
| Update task | Edit title, goal, summary, priority, acceptance criteria |
| Validate task | Record a validation pass/fail result with evidence |
| Add agent | Attach a sub-agent (framework, model, workdir, repo) to a task |
| Stop agent | Stop a specific sub-agent session |
| Send message | Send a message to a task thread |

## Requirements

- `@elizaos/core` (workspace dependency)
- `@elizaos/ui` (workspace dependency — provides client API, slot registry, shared types)
- `@elizaos/plugin-agent-orchestrator` must be running to provide task/session state; this plugin is display-only.

## Enabling

Add `@elizaos/plugin-task-coordinator` to your agent's plugin list. No env vars are required.

Per-framework coding-agent settings (model, LLM provider, approval preset) are configured through the Settings panel in the dashboard UI, not via environment variables.

## Supported agent frameworks

The settings panel manages configuration for: elizaOS, Pi Agent, OpenCode, Claude, and Codex.

## Build

```bash
bun run --cwd plugins/plugin-task-coordinator build
```

This runs tsup (plugin JS) + Vite (view bundle → `dist/views/bundle.js`) + tsc (type declarations).

## Tests

```bash
bun run --cwd plugins/plugin-task-coordinator test
```

A live end-to-end test (`test:e2e:manual`) requires the `codex` CLI to be installed and authenticated (`~/.codex/auth.json`). It is skipped automatically when those conditions are not met.
