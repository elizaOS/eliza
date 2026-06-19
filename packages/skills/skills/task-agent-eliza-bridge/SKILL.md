---
name: task-agent-eliza-bridge
description: "Use when spawning a Claude Code, Codex, Gemini, Aider, or other CLI task agent whose work needs parent Eliza runtime context. Covers the read-only loopback bridge for character, room, memory, and active workspace state."
---

# Task-Agent Eliza Bridge

Use this skill when a coding task agent needs context that lives in the parent Eliza runtime rather than in the checkout.

The orchestrator injects a parent-runtime reference into each non-shell task agent's memory file. The child can curl these loopback-only, read-only endpoints with its session id:

- `GET /api/coding-agents/<sessionId>/parent-context`
- `GET /api/coding-agents/<sessionId>/memory?q=<query>&limit=N`
- `GET /api/coding-agents/<sessionId>/active-workspaces`

## Parent Responsibilities

Before delegating work that references parent context, make sure the spawned agent has the injected memory file. The bridge is for context reads only: character/persona, originating room, model preferences, memory search, and active workspace state.

Do not give the child the parent's API key or a full memory dump. Cloud state belongs to the `eliza-cloud` skill; local runtime state belongs to this bridge.

## Child Responsibilities

The child should call the bridge only when the task depends on parent context that was not already resolved in the prompt, such as "their dad", "the project from yesterday", or "the same markup as last time".

If the bridge returns `410 task_no_longer_active`, continue in workspace-only mode and state that parent context was unavailable. If it returns `503 parent_context_timeout`, do not retry indefinitely.

## Boundaries

- Read-only GET endpoints only.
- No parent memory writes.
- No action delegation.
- No persistent child identity assumptions.
- The parent records lifecycle events through the existing hook channel.
