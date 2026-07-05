# Available skills

These skills are installed or task-scoped in the parent agent. To use one, send a USE_SKILL request back via the parent (slug + optional args).

Protocol: send a message to the parent of the form `USE_SKILL <slug> <json_args>` and the parent will execute the skill and return the result. The `<json_args>` portion is optional; omit it for skills that take no parameters or use defaults.

## Recommended for this task

- **Parent Eliza Agent** (`parent-agent`) — Task-scoped bridge for asking the running parent Eliza agent to use its loaded capabilities, actions, providers, connectors, and confirmation flow.
  - Protocol: Use when workspace context is not enough and the parent agent should do something with its own capabilities. Examples: `USE_SKILL parent-agent {"request":"Find the next free 30 minute slot on my calendar"}`, `USE_SKILL parent-agent {"mode":"list-actions","query":"github"}`, `USE_SKILL parent-agent {"mode":"list-cloud-commands"}`, or `USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.list"}`. Mutating, paid, or destructive Cloud commands require an explicit user yes on a follow-up turn (not LLM `confirmed`). Fixed-cost self-spend commands such as `containers.create` may auto-authorize within the configured agent spend cap; variable-cost self-spend commands such as `domains.buy`, `media.*`, `promote.*`, and `advertising.*` always require human confirmation because the server-quoted price cannot be trusted from child-declared `params.spendEstimateUsd`. To delegate part of your work to a NEW parallel sub-agent on this same task, use `USE_SKILL parent-agent {"mode":"spawn-sub-agent","task":"<instruction for the child>","label":"<optional name>"}` — it spawns a child sub-agent (bounded nesting depth) whose progress shows in this task's thread; keep working, do not block waiting on it.

## All enabled skills

_(none)_

## Task-scoped broker skills

These slugs are requestable only for this spawned task because the parent orchestrator allow-listed them.

- **Parent Eliza Agent** (`parent-agent`) — Task-scoped bridge for asking the running parent Eliza agent to use its loaded capabilities, actions, providers, connectors, and confirmation flow.
  - Protocol: Use when workspace context is not enough and the parent agent should do something with its own capabilities. Examples: `USE_SKILL parent-agent {"request":"Find the next free 30 minute slot on my calendar"}`, `USE_SKILL parent-agent {"mode":"list-actions","query":"github"}`, `USE_SKILL parent-agent {"mode":"list-cloud-commands"}`, or `USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.list"}`. Mutating, paid, or destructive Cloud commands require an explicit user yes on a follow-up turn (not LLM `confirmed`). Fixed-cost self-spend commands such as `containers.create` may auto-authorize within the configured agent spend cap; variable-cost self-spend commands such as `domains.buy`, `media.*`, `promote.*`, and `advertising.*` always require human confirmation because the server-quoted price cannot be trusted from child-declared `params.spendEstimateUsd`. To delegate part of your work to a NEW parallel sub-agent on this same task, use `USE_SKILL parent-agent {"mode":"spawn-sub-agent","task":"<instruction for the child>","label":"<optional name>"}` — it spawns a child sub-agent (bounded nesting depth) whose progress shows in this task's thread; keep working, do not block waiting on it.
