# Orchestrator UX Expectations

`/orchestrator` is the multi-agent workbench for creating coding tasks, watching
agent rooms, and validating the artifacts those agents produce.

Expected screen contract:

- Header: shows the Orchestrator identity, total tasks, non-zero active/blocked/validating counts, active agent count, and token/cost usage.
- Task rail: shows search, status filtering, archived toggle, each task title, status glyph, priority glyph, active/total agent count, and last activity.
- Empty state: shows a compact no-task state and a New task action.
- Create task flow: requires title and goal, captures priority and newline-delimited acceptance criteria, posts the structured payload, then opens the created task.
- Timeline: shows the selected task title, user/orchestrator/sub-agent messages, structured tool cards from events, older-message loading when paged, a running-agent bar when agents are active, and an enabled composer only when text is present.
- Inspector: shows task controls, goal, sub-agents with framework/model/workspace/usage, current plan, acceptance criteria, artifacts with verification icons, provider usage, provider policy, priority changes, add-agent form, stop controls, validation controls when validating, archive/reopen, fork, delete, and copy-link.
- Live behavior: task/status polling refreshes data, selected task polling/streaming merges timeline records by id without cross-task contamination, and Escape closes dialogs/drawers before interrupting active agents.
- Registration: plugin manifest exposes GUI, XR, and TUI orchestrator views under `/orchestrator` and `/orchestrator/tui`, all carrying the same orchestrator capability set.

Manual review notes:

- Strengths: dense three-pane layout, compact icon-first controls, real token/cost readouts, clear active-agent interrupt bar, and structured tool/event rendering rather than raw logs.
- Risks: the inspector still contains a few paragraph elements for goal/empty text, the GUI and task-coordinator views can feel similar without a seeded active task, and full live provider testing depends on local Codex/Cerebras availability.
- Verification target: Playwright should cover both the empty/create flow and a seeded data-rich room with agents, plan, acceptance criteria, artifacts, messages, events, provider policy, and inspector mutations.
