# Issue #13427 — Meeting Credit Reservations

## Verification

- `bun run --cwd plugins/plugin-meetings test src/service.test.ts src/routes/meetings-routes.test.ts src/pipeline/__tests__/pipeline.test.ts`
  - 3 files, 47 tests passed.
- `bun run --cwd plugins/plugin-meetings typecheck`
  - Passed.
- `bunx biome check packages/cloud/shared/src/lib/index.ts packages/cloud/shared/src/lib/services/meeting-billing.ts packages/cloud/shared/src/lib/services/__tests__/meeting-billing.test.ts packages/shared/src/meetings.ts plugins/plugin-meetings/src/types.ts plugins/plugin-meetings/src/service.ts plugins/plugin-meetings/src/pipeline/pipeline.ts plugins/plugin-meetings/src/test-support.ts plugins/plugin-meetings/src/service.test.ts plugins/plugin-meetings/src/routes/meetings-routes.ts plugins/plugin-meetings/src/routes/meetings-routes.test.ts plugins/plugin-meetings/src/pipeline/__tests__/pipeline.test.ts`
  - Passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/meeting-billing.test.ts > /tmp/meeting-billing-test-full.out 2>&1`
  - 6 tests passed, 0 failed.
  - Manually reviewed pass lines for:
    - initial launch reservation,
    - bounded chunk extension,
    - unused reservation refund,
    - insufficient initial credits,
    - spend-cap refusal before ASR continues,
    - exactly-once reconciliation under racing exits.

## Notes

- `bun run --cwd packages/cloud/shared typecheck` still fails on pre-existing transitive `@elizaos/auth/*` resolution errors from `packages/app-core`; filtering the output showed no diagnostics for the new meeting billing files.
- Live funded-organization proof remains tracked in #13428, which requires real cloud credentials and production billing rows.
