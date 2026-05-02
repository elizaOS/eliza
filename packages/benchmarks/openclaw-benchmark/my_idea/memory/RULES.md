# Agent Rules (The Constitution)

This file is the **Long-Term Memory** of the agent system.
**Rule:** When an agent makes a mistake that leads to a failure, it MUST append a new rule here to prevent it from happening again.

## 1. General Safety
- [ ] **No Destructive Commands:** Never run `rm -rf /` or similar without isolation.
- [ ] **Verify Before Commit:** Always run the build/test script defined in `tasks.json` before marking a task done.

## 2. Coding Patterns
*   (Agents will add patterns here, e.g., "Always use `const` instead of `var` in TS")

## 3. Communication
- [ ] **No Hallucinations:** Do not reference files that do not exist. Check with `ls`.
