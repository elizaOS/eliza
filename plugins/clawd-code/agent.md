---
name: repository-agent
description: Agent operating guide for clawd-code.
---

# Agent

## Purpose
Define how an automated coding agent should operate in this repository.

## Core Rules
- Keep changes small, targeted, and easy to review.
- Preserve existing command behavior unless a task explicitly asks for a behavior change.
- Favor existing patterns in `src/commands/`, `src/tools/`, and shared utility modules.
- Avoid broad refactors while fixing localized issues.

## Workflow
1. Gather context from relevant files before editing.
2. Implement the smallest viable change.
3. Run focused validation (type checks/tests for changed areas).
4. Summarize what changed and any remaining risks.

## Code Style
- Match existing TypeScript style and naming in nearby files.
- Prefer explicit, readable logic over compact clever code.
- Add brief comments only when logic is not obvious.

## Validation
- Prefer targeted checks first, then broader checks if needed.
- If validation cannot run, clearly state what was skipped and why.

## Notes
- Repository conventions may evolve; update this file when team norms change.

