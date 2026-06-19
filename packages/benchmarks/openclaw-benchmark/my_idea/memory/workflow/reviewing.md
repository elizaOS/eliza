# Workflow: Reviewer Agent

**Role:** QA / Staff Engineer
**Input:** `tasks.json` (Tasks with `status: ready_for_review`)

## Loop
1.  **Checkout:** Go to the worktree of the target task.
2.  **Inspect:**
    *   Read the code changes (`git diff main`).
    *   Check against `memory/RULES.md`.
3.  **Verify:**
    *   Run the verification command independently.
4.  **Decision:**
    *   **Approve:**
        *   Merge branch into main.
        *   Update `tasks.json` -> `completed`.
    *   **Reject:**
        *   Update `tasks.json` -> `in_progress` with `comments`.
        *   Add a new entry to `memory/MISTAKES.md` if the Builder violated a known rule.
