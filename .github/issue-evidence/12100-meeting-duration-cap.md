# Issue 12100 Evidence: Meeting Duration Cap Contract

## Local proof captured

- `bunx vitest run plugins/plugin-meetings/src/service.test.ts plugins/plugin-meetings/src/routes/meetings-routes.test.ts packages/shared/src/meetings.test.ts`
  - Result: 3 files passed, 36 tests passed.
- `bun run --cwd packages/shared typecheck`
  - Result: blocked in this checkout by pre-existing logger declaration
    resolution for `adze`, `adze/dist/log.js`, and `fast-redact`; no reported
    error was in `packages/shared/src/meetings.ts`.
- `bun run --cwd plugins/plugin-meetings typecheck`
  - Result: clean.
- `bunx @biomejs/biome check packages/shared/src/meetings.ts plugins/plugin-meetings/src/routes/meetings-routes.ts plugins/plugin-meetings/src/service.ts plugins/plugin-meetings/src/service.test.ts plugins/plugin-meetings/src/routes/meetings-routes.test.ts`
  - Result: clean.
- `git diff --check`
  - Result: clean.

## Contract covered by tests

- Every `MeetingJoinRequest` resolves to a bounded `maxDurationMs`.
- The production default cap is 60 minutes.
- Callers may request a lower per-session `maxDurationMs`.
- Requests above the configured `ELIZA_MEETINGS_MAX_DURATION_MS` fail before a bot launches.
- When the cap is reached, the service transitions to leaving, aborts the adapter signal, finalizes the pipeline, and records `endReason: "duration_cap_reached"`.
- The duration-cap reason wins even when the adapter resolves `requested_stop`
  synchronously from the abort signal.

## Evidence not captured

- Cloud credit reservation rows and reconciliation: N/A in this environment; the cloud-money reservation contract and test org were not provided.
- Insufficient-credit and cap-reached billing rows: N/A in this environment; no credit setup or metered Cloud test org was provided.
- Live meeting route logs/transcript/manual review: N/A in this environment; no approved live fixture/credential set was provided.
