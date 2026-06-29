# Issue #9950 evidence: dashboard smoke and aesthetic coverage

## What changed

- Added assertion-grade dashboard smoke specs for browser workspace, wallet inventory, workflow editor, and live-stack character-editor round trips.
- Extended UI smoke device coverage with mobile portrait, mobile landscape, desktop landscape, and iPad portrait projects for assertion-grade dashboard specs.
- Hardened all-view interaction and aesthetic audit coverage, including actual overlay clearance, text density, border/divider density, and whitespace budgets.
- Improved the browser workspace empty state and close-all-tabs behavior so tab lifecycle flows are directly testable.

## Verification

- `bun run --cwd packages/app test -- test/core-view-interaction-coverage.test.ts test/audit/aesthetic-audit-rules.test.ts`: 2 files passed, 35 tests passed.
- `bun run --cwd packages/app test:e2e test/ui-smoke/browser-workspace.spec.ts test/ui-smoke/all-views-interaction.spec.ts`: 39 passed.
- `bun run --cwd packages/app test:e2e test/ui-smoke/wallet-inventory.spec.ts test/ui-smoke/workflow-editor.spec.ts test/ui-smoke/character-editor.spec.ts`: 10 passed, 5 skipped; skipped tests are live-stack-only behind `ELIZA_UI_SMOKE_LIVE_STACK`.
- `bun run --cwd packages/app audit:app`: 369 passed. Report summary: 368 findings, `good=140`, `needs-eyeball=228`, `broken=0`, `needs-work=0`, `minimalismBudgetFailures=0`, `overlayClearanceIssues=0`.
- `bun run verify`: passed after the app audit on the synced base.

## Artifacts

- Browser mobile portrait after screenshot: `9950-browser-mobile-portrait-after.png`
- Browser desktop landscape after screenshot: `9950-browser-desktop-landscape-after.png`
- Inventory desktop landscape after screenshot: `9950-inventory-desktop-landscape-after.png`
- Wallet plugin mobile portrait after screenshot: `9950-wallet-plugin-mobile-portrait-after.png`

## Evidence type coverage

- Frontend logs/network: covered by Playwright page error, request failure, API 5xx, and aesthetic audit console capture assertions.
- Backend logs: N/A, this is UI smoke/audit coverage and local UI behavior hardening.
- Real-LLM trajectories: N/A, no agent/action/prompt/model behavior changed.
- Before screenshots: N/A, this branch did not capture pre-change screenshots before implementation began; after screenshots and full audit output were captured on the final synced base.
- Video/audio: N/A, no voice, TTS, STT, or narrated interaction behavior changed.
