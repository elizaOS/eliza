# #13451 Settings shared-header slice

## Scope

Changed the mobile/narrow Settings section detail view to use the shared
`ViewHeader` contract instead of the section-local text back button. Also made
the shared view back button backgroundless at rest so normal-view headers use an
icon-only affordance.

This is a narrow Settings slice for #13451. Browser, Wallet, Launcher subviews,
and the full shell-owned header contract remain broader follow-up work.

## Local verification

Command:

```bash
bunx @biomejs/biome check --write packages/ui/src/components/shared/ViewHeader.tsx packages/ui/src/components/pages/SettingsView.tsx packages/ui/src/components/pages/SettingsView.test.tsx
```

Result: passed; Biome formatted the touched files.

Command:

```bash
bunx @biomejs/biome check packages/ui/src/components/shared/ViewHeader.tsx packages/ui/src/components/pages/SettingsView.tsx packages/ui/src/components/pages/SettingsView.test.tsx
```

Result: passed.

## Test coverage added

`packages/ui/src/components/pages/SettingsView.test.tsx` now asserts that a
selected Settings section renders the shared `view-header`, that its title is
centered under the shared header contract, that the back control is accessible
as `Back to Settings`, that the button is icon-only, and that its resting class
uses `bg-transparent` instead of a filled `bg-bg` chip.

## Blocked verification

Command:

```bash
bun run --cwd packages/ui test src/components/pages/SettingsView.test.tsx
```

Result: blocked before test execution because the temp worktree dependency tree
cannot resolve `react/package.json` while loading `packages/ui/vitest.config.ts`.

The local host also only has CommandLineTools selected and lacks an available
iOS simulator SDK, so iOS simulator screenshots, screen recording, and
installed-app capture could not be produced locally for this UI slice.

## Evidence not applicable for this slice

Real-LLM trajectories: N/A - this changes UI header rendering only; no
agent/action/provider/prompt/model behavior changed.

Backend logs: N/A - no backend code path changed.

Domain artifacts: N/A - no persisted memories, scheduled tasks, database rows,
files, or on-chain/device artifacts are produced by this header change.
