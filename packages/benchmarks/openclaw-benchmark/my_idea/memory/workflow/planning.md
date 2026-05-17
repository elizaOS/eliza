# Workflow: Planner Agent

**Role:** Staff Engineer / Architect
**Output:** `tasks.json`

## Loop
1.  **Read User Request**: Understand the high-level goal.
2.  **Read Memory**: Check `memory/RULES.md` to avoid past pitfalls.
3.  **Explore**: Read existing codebase structure (`ls -R`, `cat README.md`).
4.  **Draft Plan**:
    *   Break down the goal into atomic features.
    *   Define dependencies.
    *   Estimate complexity.
5.  **Write `tasks.json`**:
    *   Create a JSON list of tasks.
    *   Each task must have:
        *   `id`: unique string (e.g., `feat-auth`).
        *   `description`: precise instructions.
        *   `verification_cmd`: command to prove it works.
6.  **Handover**:
    *   Trigger the `start_session.sh` script to spawn Builder agents for the first set of parallelizable tasks.
