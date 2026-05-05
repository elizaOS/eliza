---
title: Developer Playbook
sidebarTitle: Dev Playbook
summary: Practical workflows and quality gates for shipping reliable, review-ready changes to Eliza.
description: Practical workflows, checklists, and quality gates for contributing to Eliza reliably.
---

This playbook is the practical "how we build" companion to the contribution policy docs.

## 1) PR sizing strategy

Prefer small PRs with one clear purpose:

- One bug fix
- One behavior enhancement
- One doc improvement batch

Split when PR includes unrelated concerns.

## 2) Implementation workflow (default)

1. Reproduce issue / define behavior
2. Write or update test
3. Implement minimal change
4. Run checks
5. Self-review diff
6. Commit with concise action-oriented message

## 3) Quality gates before PR

Minimum:

```bash
bun run check
bun run test
```

Add targeted checks when needed (e2e, db-specific checks, docs checks).

## 4) Security review checklist

Before opening PR, verify:

- No secrets committed
- No hidden network/data exfil paths
- New external calls are explicit and justified
- Permissions/auth implications are documented

## 5) Runtime stability checklist

For startup/runtime/plugin-related changes:

- Validate startup behavior remains intact
- Validate plugin resolution still works
- Validate failure paths remain user-visible and recoverable
- Confirm Node/Bun compatibility where relevant

## 6) Test planning template

Use this mini-template in PR descriptions:

- **Behavior changed:**
- **What could break:**
- **Tests added/updated:**
- **Manual scenarios run:**
- **Known gaps:**

## 7) Docs change policy

If user-facing behavior changes, docs should update in same PR whenever practical.

Good doc updates include:

- command examples,
- config keys,
- troubleshooting notes,
- migration notes.

## 8) Review ergonomics

Help reviewers by including:

- short summary bullets,
- why this is needed,
- why alternatives were not chosen,
- explicit risk level.

## 9) Release/rollback thinking

For non-trivial changes, include rollback plan:

- feature flag or config gate,
- revert procedure,
- state/data impact note.

## 10) Progression after this playbook

Then go deeper with:

- `/guides/first-extension-walkthrough`
- `/plugins/architecture`
- `/agents/runtime-and-lifecycle`
- `/advanced/logs`
