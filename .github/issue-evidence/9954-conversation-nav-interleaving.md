# Conversation Nav Interleaving Evidence

Issue: #9954 chat-ux conversation-nav interleaving
Updated verification: 2026-06-29 on the clean Linux `origin/develop`
verification worktree.

## Current status

The earlier Windows-local blocker notes below are superseded by the clean
verification pass. The issue is now closed and the current tree has passing
unit/fuzz, real-overlay gesture E2E, chat-sheet E2E, render parity, and app
audit evidence.

Current durable artifacts live in:

- `.github/issue-evidence/9954-chat-ux/README.md`
- `.github/issue-evidence/9954-chat-ux/chatux-gestures.webm`
- `.github/issue-evidence/9954-chat-ux/38-state-maximized-with-inset.png`
- `.github/issue-evidence/9954-chat-ux/50-state-streaming-dots-in-bubble.png`
- `.github/issue-evidence/9954-chat-ux/51-state-multi-send-while-responding.png`

Current validation:

```text
bun run --cwd packages/ui test:chatux-gesture-e2e  PASS
bun run --cwd packages/ui test:chat-sheet-e2e      PASS
bun run --cwd packages/app audit:app               369 passed
bun run verify                                     PASS
```

The original focused change notes are retained below for historical context.

## Original change

- Extracted pure adjacent-conversation navigation to
  `packages/ui/src/components/shell/conversation-nav.ts`.
- Added `resolveAdjacentConversationId`, so hook-level callbacks can resolve the
  latest adjacent target at gesture time instead of trusting a stale closure.
- Kept `buildConversationNav` re-exported from `useShellController.ts` for
  compatibility with existing tests/imports.
- Added a conversation-transition busy ref tied to the existing loading sequence
  so a second swipe during an in-flight select/create is dropped.
- Added a fast-check generated interleaving test for the pure most-recent-first
  nav invariants.
- Added hook regression tests for:
  - dropping a second stale swipe while the first switch is pending;
  - re-resolving an old callback against the latest active conversation after a
    rerender.

## Validation

```text
$ bun run biome check --config-path biome.json --files-ignore-unknown=true --no-errors-on-unmatched packages\ui\src\components\shell\conversation-nav.ts packages\ui\src\components\shell\useShellController.ts packages\ui\src\components\shell\conversation-nav.test.ts packages\ui\src\components\shell\__tests__\useShellController.test.tsx
Checked 4 files in 1691ms. No fixes applied.
```

```text
$ bun run --cwd packages/ui test -- src/components/shell/conversation-nav.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)
```

```text
$ git diff --check
# no output
```

## Local Blockers

The hook regression file cannot run on this workstation because the local Bun
dependency store is incomplete before the test imports:

```text
$ bun run --cwd packages/ui test -- src/components/shell/__tests__/useShellController.test.tsx
Error: Cannot find module '...node_modules\.bun\drizzle-orm@0.45.2...\node_modules\drizzle-orm\table.utils.js'
```

The package typecheck is also blocked by the current local dependency/type graph,
starting with Drizzle and missing charting/runtime types:

```text
$ bun run --cwd packages/ui typecheck
../cloud/shared/src/db/client.ts(33,55): error TS2344: Type 'ExtractTablesWithRelations<...>' does not satisfy the constraint 'TablesRelationalConfig'.
../cloud/shared/src/db/schemas/ad-accounts.ts(1,15): error TS2305: Module '"drizzle-orm"' has no exported member 'InferInsertModel'.
src/cloud/analytics/_components/projections-chart.tsx(23,8): error TS2307: Cannot find module 'recharts' or its corresponding type declarations.
```

Those failures occur outside the changed shell nav files and match the broader
Windows dependency-store limitation noted in the current issue-board triage.

The repo-required app visual audit was attempted because this touches
`packages/ui`, but it is blocked by an existing Windows UI-smoke launcher issue:

```text
$ bun run --cwd packages/app audit:app
Error: spawn bun ENOENT
  syscall: 'spawn bun'
  path: 'bun'
  spawnargs: [ 'run', 'build:views' ]
```

This branch does not change visible layout or styling; the audit blocker is
queued as a separate workflow-fix follow-up.
