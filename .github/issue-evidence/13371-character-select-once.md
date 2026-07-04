# Issue #13371 — character select should not replay on every iOS launch

Date: 2026-07-04

## Change

- Split first-run completion tracking into two refs:
  - `completionCommittedRef`: durable recovery flag, still seeded from
    `eliza:first-run-complete`.
  - `completionJustCommittedRef`: in-memory one-shot handoff for the immediate
    post-onboarding character-select route.
- Startup hydration now consumes only the one-shot ref when deciding whether to
  land on `character-select`.
- A relaunch with persisted first-run completion now lands on the normal default
  tab instead of replaying character select.

## Verification

- `bun run --cwd packages/ui test src/state/startup-phase-hydrate.character-select.test.ts src/state/first-run-completion-persist.test.tsx`
  - 2 files passed, 9 tests passed.
- `bunx @biomejs/biome check packages/ui/src/state/useFirstRunState.ts packages/ui/src/state/useFirstRunCallbacks.ts packages/ui/src/state/startup-phase-hydrate.ts packages/ui/src/state/AppContext.tsx packages/ui/src/state/first-run-completion-persist.test.tsx packages/ui/src/state/startup-phase-hydrate.character-select.test.ts --no-errors-on-unmatched`
  - Passed.
- `bun run --cwd packages/ui typecheck`
  - Passed.
- `git diff --check`
  - Passed.

## Not captured yet

- Real iOS simulator relaunch walkthrough/video is not captured in this local
  pass.
- `bun run --cwd packages/app audit:app` was attempted and failed before
  screenshots because the local Node executable is too old:
  - `/opt/homebrew/bin/node` is `v23.3.0`
  - `/usr/local/bin/node` is `v18.13.0`
  - app-core runtime requires Node.js 24+ and reported:
    `Invalid ELIZA_NODE_PATH=/opt/homebrew/bin/node: Node.js 23.3.0 is too old`
