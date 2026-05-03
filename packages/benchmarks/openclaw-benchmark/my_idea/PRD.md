# PRD: Autonomous Coding Template (ACT)

**Status:** Beta Template
**Vision:** "The Repository that Codes Itself."

## 1. Problem Statement
Manual agent workflows are brittle regardless of the LLM used.
*   **Context Loss:** Single sessions eventually forget rules.
*   **Blocking:** Waiting for an agent to finish a task blocks the next one.
*   **Regression:** Agents repeat the same mistakes.

## 2. The Solution: "ACT" (Autonomous Coding Template)
A project-agnostic structure that enforces:
1.  **Parallelism:** Via `git worktrees`.
2.  **Memory:** Via `RULES.md` (Self-Correction).
3.  **Governance:** Via `tasks.json` and explicit Reviewer roles.

## 3. Architecture

### The Roles
*   **Planner:** Only edits `tasks.json`. Dictates the "What".
*   **Builder:** Only edits Code in a `feat/` worktree. Handles the "How".
*   **Reviewer:** Only edits `status` and `comments`. Handles the "Quality".

### The Loop
1.  **Init:** `init_env.sh` prepares the ground.
2.  **Plan:** User or Planner fills `tasks.json` (Source of Truth).
3.  **Dispatch:** Builders pick up `pending` tasks in isolated worktrees.
4.  **Review:** Reviewer validates `ready_for_review` tasks.
5.  **Merge:** Approved tasks are merged to main.

## 4. Implementation Status
See `feature_list.json` for the current backlog of *this template itself*.

## 5. Usage
To use this template for a NEW project:
1.  Copy this entire folder to your new repo root.
2.  Run `./scripts/init_env.sh`.
3.  Delete `feature_list.json` and start fresh or adapt it.
4.  Start your first agent with: "Read `workflow/planning.md` and help me plan this project."
