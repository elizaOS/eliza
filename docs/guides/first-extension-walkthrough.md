---
title: First Extension Walkthrough
sidebarTitle: First Extension
summary: Build your first Eliza extension safely using existing plugin docs and runtime guardrails.
description: A practical first-extension walkthrough for developers who want to extend Eliza with plugins, actions, and runtime-safe patterns.
---

This guide is a practical bridge between beginner docs and full plugin architecture docs.

## Goal

Ship one small extension that is:

- useful,
- testable,
- safe to review,
- and easy to iterate.

## Step 0: Pick an intentionally small extension

Good first targets:

- Add one new action with clear input/output
- Add one provider that injects lightweight context
- Add one plugin capability that does not require broad refactors

Avoid for first attempt:

- Multi-plugin orchestration
- Heavy runtime lifecycle changes
- Changes to startup resolution internals

## Step 1: Read the right docs in order

1. `/plugins/overview`
2. `/plugins/architecture`
3. `/plugins/create-a-plugin`
4. `/plugins/development`
5. `/plugins/local-plugins`

## Step 2: Define extension contract before coding

Write down:

- Problem statement
- Inputs and outputs
- Failure behavior
- Security constraints (secrets, external calls, data handling)
- Test plan

This keeps implementation scoped and review-friendly.

## Step 3: Implement minimal behavior

Implementation rules:

- Keep code path small
- Prefer explicit types
- Add comments only where logic is non-obvious
- Do not remove existing runtime safeguards

## Step 4: Wire into local environment

Use local plugin loading docs and runtime config paths to install and enable your extension for development.

Then perform one deterministic manual scenario that exercises the new behavior.

## Step 5: Add tests early

Minimum test expectations:

- Happy-path behavior
- Known failure path
- Regression guard for issue fixed or behavior added

If external dependencies exist, mock them where possible.

## Step 6: Validate and self-review

Recommended checks:

```bash
bun run check
bun run test
```

Then review your own diff for:

- scope creep,
- hidden behavior changes,
- missing docs,
- security assumptions.

## Step 7: Document usage

Update docs with:

- what the extension does,
- how to configure it,
- how to validate it,
- known limitations.

If behavior is user-facing, include at least one copy-paste-ready example.

## Step 8: Prepare PR notes reviewers actually need

Include:

- Scope (exactly what changed)
- Test evidence (commands and outcomes)
- Security considerations
- Rollback strategy (what to disable/revert if needed)

## Step 9: Common first-extension mistakes

- Extension does too many unrelated things
- No tests for failure behavior
- Docs lag implementation
- Adds dependencies without clear need
- Assumes one runtime path (Node or Bun) only

## Step 10: Next extensions after first success

After your first extension ships, move to:

- richer plugin patterns (`/plugins/patterns`)
- publishing and versioning (`/plugins/publish`)
- skills + custom actions + triggers integration
