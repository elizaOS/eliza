# Issue 11916 — UI Design-System Consolidation Evidence

## Scope

Consolidated launcher/chat/settings/browser/wallet/app controls onto shared
`packages/ui` primitives, added `Button` `unstyled` support for custom chrome,
and fixed mobile-landscape continuous-chat clearance for browser and wallet
surfaces.

## Screenshots

Final `bun run --cwd packages/app audit:app` captures copied from
`packages/app/aesthetic-audit-output/`:

- `11916-ui-design-system-consolidation/browser-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/inventory-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/plugin-wallet-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/plugin-birdclaw-mobile-landscape-after.png`
- `11916-ui-design-system-consolidation/settings-desktop-after.png`
- `11916-ui-design-system-consolidation/chat-mobile-portrait-after.png`

Before screenshots: N/A - this change is a broad primitive consolidation and
the earlier failing audit captures were superseded by the final audit run.

Video walkthrough: N/A - no data-entry workflow, backend transaction, model
trajectory, or connector flow changed; verification is via full app screenshot
matrix and focused package tests.

## Verification

All commands were run from
`/Users/shawwalters/eliza-workspace/milady/eliza-ui-design-system-pr`.

- `bun run --cwd packages/core typecheck` — passed.
- `bun run --cwd packages/ui typecheck` — passed.
- `bun run --cwd packages/ui test -- src/genui/genui.test.tsx src/cloud-ui/__tests__/cloud-ui-stories-smoke.test.tsx` — passed, 380 tests.
- `bun run --cwd plugins/plugin-birdclaw typecheck` — passed.
- `bun run --cwd plugins/plugin-birdclaw test` — passed, 69 tests.
- `bun run --cwd plugins/plugin-wallet-ui typecheck` — passed.
- `bun run --cwd plugins/plugin-wallet-ui test` — passed, 39 tests.
- `bun run --cwd packages/app audit:app` — passed, 357 tests; summary:
  `broken=0 needs-work=0 needs-eyeball=25 good=331 minimalism-budget-failures=0 minimalism-ratchet-failures=0 hover-probe-failures=0 density-probe-failures=0`.
- `bun run verify` — passed; turbo typecheck/lint reported 485 successful tasks
  and `typecheck:dist` checked 28 dist-path consumer configs.

## Static Scans

- `packages/ui/src` raw-control scan found only doc-comment examples.
- `plugins/plugin-wallet-ui/src` raw-control scan found no production
  `button/input/select/textarea` matches.
- `git diff --cached --check` — passed.

## N/A Evidence

- Real LLM trajectories: N/A - no prompt, provider, model, action, evaluator, or
  runtime agent behavior changed.
- Backend logs: N/A - no server route or backend side effect changed.
- Domain artifacts: N/A - no memory, database, scheduler, wallet transaction,
  generated file workflow, or chain state changed.
