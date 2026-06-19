# Autonomous Coding Template (ACT)

**Status:** Experimental Template
**Goal:** A project-agnostic harness for long-running, self-optimizing AI agents using `opencode` (or Claude Code).

## Core Philosophy
Inspired by the "Ralph Wiggum" technique and Anthropic's internal workflows.

1.  **Parallel Execution:** We use `git worktrees` to run multiple agent sessions in parallel without file locking conflicts.
    *   *Planner* works on `main`.
    *   *Builder* works on `feat/xyz` in a separate folder.
    *   *Reviewer* checks `feat/xyz` in a separate folder.
2.  **Self-Correction:** Agents maintain a `memory/RULES.md` file. Every time they fail, they *must* update this file with a new rule to prevent recurrence.
3.  **Role Separation:**
    *   **Planner:** Breaks down high-level requests into `tasks.json`.
    *   **Builder:** Executes tasks in isolation.
    *   **Reviewer:** "Staff Engineer" persona that critiques code before merge.

## Directory Structure

```
.
├── workflow/           # Defines the agent loops
│   ├── planning.md     # Instructions for the Planner
│   ├── building.md     # Instructions for the Builder
│   └── reviewing.md    # Instructions for the Reviewer
├── memory/             # Persistent agent memory
│   ├── RULES.md        # The "Constitution" (Self-Optimizing)
│   └── MISTAKES.md     # Log of past errors
├── scripts/            # Automation
│   ├── start_session.sh # Sets up worktrees
│   └── merge_agent.sh   # Safely merges agent work
└── tasks.json          # The Central Nervous System (Task State)
```

## Getting Started

1.  **Init:** Run `./scripts/init_worktrees.sh` to create the parallel environments.
2.  **Plan:** Start an agent in the `root` with `workflow/planning.md`.
3.  **Build:** The system spawns an agent in `worktrees/feat-1` with `workflow/building.md`.
