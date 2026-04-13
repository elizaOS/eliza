# Workflow: Builder Agent

**Role:** Senior Developer
**Input:** `tasks.json` (Specific Task ID)

## Loop
1.  **Read Task:** Identify your assigned Task ID in `tasks.json`. Read the description and requirements.
2.  **Read Rules:** Review `memory/RULES.md`.
3.  **Implement:**
    *   Write code.
    *   **Constraint:** You are in a dedicated git worktree. You can modify files freely without blocking others.
4.  **Verify:**
    *   Run the verification command defined in the task.
    *   *Self-Correction:* If verification fails, fix it. If you are stuck, record the mistake in `memory/MISTAKES.md` and update `RULES.md`.
5.  **Submit:**
    *   Mark the task as `ready_for_review` in `tasks.json`.
    *   Push the branch.
    *   Exit.
