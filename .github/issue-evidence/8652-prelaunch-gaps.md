# 8652 pre-launch gaps

## Scope Covered

- `@elizaos/plugin-inbox` now owns persisted triage queue routes and action ops for list/search/summarize/triage/reply/snooze/archive/approve.
- `@elizaos/plugin-wallet` now routes `pump_fun_buy` through a registered pump.fun Solana handler with the existing human confirmation gate.
- Package docs (`README.md`, `CLAUDE.md`, `AGENTS.md`) were updated to remove stale scaffold language and document the new surfaces.

## Validation

Passed locally on this branch:

- `bun install`
- `bun run --cwd plugins/plugin-inbox lint`
- `bun run --cwd plugins/plugin-inbox typecheck`
- `bun run --cwd plugins/plugin-inbox test`
  - 15 files passed, 1 skipped
  - 108 tests passed, 2 skipped
- `bun run --cwd plugins/plugin-inbox build`
- `bun run --cwd plugins/plugin-wallet lint`
- `bun run --cwd plugins/plugin-wallet check`
- `bun run --cwd plugins/plugin-wallet test`
  - 23 files passed, 1 skipped
  - 105 tests passed, 1 skipped
- `bun run --cwd plugins/plugin-wallet build`
- `git diff --check`

Repo-level `bun run verify` was attempted and stopped at the pre-Turbo type-safety ratchet:

- `as unknown as`: 107 current > 77 baseline
- ``?? 0`` in core/agent/app-core: 381 current > 380 baseline

The ratchet output pointed at unrelated packages such as `packages/feed`, `packages/agent`, `packages/app-core`, and `packages/core`; it did not report the changed inbox or wallet files.

## Evidence Notes

- Real PumpPortal/on-chain transaction: N/A for this local validation because no funded Solana wallet was configured and executing a pump.fun buy would spend real SOL. The code path is covered by router/confirmation tests and build/typecheck.
- App screenshots/video: N/A because this change does not alter `packages/app` UI; plugin-inbox view registration was regression-tested and package build produced the view bundle.
- iOS/App Store signing evidence: N/A because this change does not touch iOS bundle IDs, signing, or native release configuration.
- Live LLM trajectories: N/A for this local validation because `INBOX_LLM_LIVE_TEST` was not enabled and no live model endpoint was configured; the live-LLM test file skipped by design.
