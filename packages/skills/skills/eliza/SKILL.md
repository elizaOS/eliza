---
name: eliza
description: "Use for spawned coding/task agents working on the Eliza app or asking what the running Eliza agent can do. Covers the repo CWD, default skill loading and overrides, child-to-parent USE_SKILL calls, parent runtime context APIs, plugin loading/building, Cloud app/payment/domain/media capabilities, and how workers can ask the parent agent to use loaded capabilities."
---

# Eliza

Eliza is this repo's local-first agent app and Cloud-backed product built on elizaOS. Use this skill when a worker needs to understand the running Eliza agent, work inside the Eliza checkout, build or modify the agent, or ask the parent runtime for information/actions that are not available from files alone.

## Read These References First

- `references/agent-orchestration.md` for spawned-worker protocol, CWD, `SKILLS.md`, `USE_SKILL`, and parent runtime APIs
- `references/capability-map.md` for what Eliza can do through plugins, services, actions, connectors, Cloud, and orchestration
- `references/plugin-and-skill-lifecycle.md` for loading, unloading, building, and overriding plugins and skills

## Worker Protocol

1. Read the local repo instructions first: `AGENTS.md`, `CLAUDE.md`, and any task-provided memory file.
2. Stay in the provided CWD. The orchestrator injects the workspace path into the agent memory file; do not leave it for `/tmp`, `$HOME`, or another checkout.
3. If `ELIZA_SKILLS_MANIFEST` or `SKILLS.md` exists, read it before assuming a capability is unavailable.
4. To ask the running parent Eliza agent for information or actions, emit a standalone line:

```text
USE_SKILL parent-agent {"request":"Describe exactly what you need the parent Eliza agent to do"}
```

5. To inspect parent actions first:

```text
USE_SKILL parent-agent {"mode":"list-actions","query":"github"}
```

6. To call deterministic Eliza Cloud APIs through the parent account, inspect commands with `USE_SKILL parent-agent {"mode":"list-cloud-commands"}` and call them with `mode:"cloud-command"`. Paid, mutating, or destructive Cloud commands require parent/user confirmation and `confirmed:true`.
7. Use parent capabilities for data/actions that belong to the parent runtime: calendar, GitHub, browser, app/cloud account state, user-confirmed paid operations, payment requests, domain purchases, promotion/media generation, private memory, connector state, and plugin-specific tools.
8. If the parent asks for confirmation or returns a blocker, continue from that result. If you need the human to decide, print `DECISION: <specific question or blocker>`.

## Related Skills

- `elizaos` for upstream runtime abstractions and plugin development
- `eliza-app-development` for this app repo's layout and product architecture
- `eliza-cloud` for Cloud APIs, app auth, containers, credits, billing, payments, domains, promotion, and media generation
- `build-monetized-app` for shipping Cloud apps that earn from inference usage, app-credit purchase share, charge links, or x402 payment requests
- `task-agent-eliza-bridge` for lower-level child-to-parent bridge details
