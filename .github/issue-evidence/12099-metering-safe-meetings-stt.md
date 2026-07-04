# Issue 12099 Evidence: Metering-Safe Meetings STT

## Local proof captured

- `bunx vitest run plugins/plugin-meetings/src/pipeline/__tests__/transcriber.test.ts plugins/plugin-meetings/src/pipeline/__tests__/pipeline.test.ts plugins/plugin-meetings/src/pipeline/__tests__/speaker-streams.test.ts`
  - Result: 3 files passed, 32 tests passed.
- `bunx @biomejs/biome check packages/core/src/types/model.ts plugins/plugin-meetings/src/pipeline/speaker-streams.ts plugins/plugin-meetings/src/pipeline/transcriber.ts plugins/plugin-meetings/src/pipeline/pipeline.ts plugins/plugin-meetings/src/pipeline/__tests__/transcriber.test.ts plugins/plugin-meetings/src/pipeline/__tests__/pipeline.test.ts plugins/plugin-meetings/src/pipeline/__tests__/speaker-streams.test.ts`
  - Result: clean.
- `bun run --cwd packages/core typecheck`
  - Result: blocked in this checkout by existing declaration-resolution noise through `/home/shaw/milady/eliza/dist/node_modules` (`drizzle-orm`, `yaml`, `fs-extra`, `adze`, etc.); no reported error was in the changed model type.
- `bun run --cwd plugins/plugin-meetings typecheck`
  - Result: clean.
- `git diff --check origin/develop...HEAD`
  - Result: clean.

## Billing invariant covered by unit tests

- Cadence-driven overlapping LocalAgreement windows are marked `purpose: "interim"`.
- Interim windows route through provider hint `eliza-local-inference`.
- Interim windows are skipped instead of retried/escalated when no `eliza-local-inference` TRANSCRIPTION provider is registered.
- Interim transcription params include `billing.billable: false` with reason `meeting-local-agreement-overlap`.
- Idle/final no-transcript flush submissions are marked `purpose: "final"`.
- Final transcription params include `billing.billable: true` with reason `meeting-final-window`.

## Evidence not captured

- Live metered Cloud STT route logs: N/A in this environment; no metered Cloud STT credential/test org was provided.
- Billing/reservation rows: N/A in this environment; no billing test org was provided.
- 30-minute approved live-audio fixture matrix: N/A in this environment; no approved fixture matrix was provided.
- Manual transcript review against the live fixture matrix: N/A in this environment for the same reason.
