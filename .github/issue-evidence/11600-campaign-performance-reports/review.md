# Issue #11600 Campaign Performance Reports

Manual review date: 2026-07-03

## Artifacts Reviewed

- `report.json`: opened and checked campaign identity, platform/provider IDs, date range, spend, impressions, clicks, conversions, CTR/CPC/CPM, budget, and attribution fields.
- `report.csv`: opened and checked that the same server-computed DTO fields export as CSV without raw credentials or ad account secrets.

## Validation

- `bun run install:light` passed in `/tmp/eliza-11600-pr`.
- `bun run --cwd packages/core build` passed; needed so middleware tests could import local workspace core.
- `bun run --cwd packages/cloud/shared typecheck` passed.
- `bun run --cwd packages/cloud/api typecheck` passed.
- `bun run --cwd packages/cloud/shared lint` passed.
- `bun run --cwd packages/cloud/api lint` passed.
- `bun test packages/cloud/api/__tests__/advertising-campaign-report-route.test.ts packages/cloud/api/__tests__/middleware-auth-public-token-paths.test.ts` passed: 16 tests, 0 failures.
- `bun test packages/cloud/shared/src/lib/services/__tests__/ad-campaign-credit-reconciliation.test.ts` passed: 16 tests, 0 failures.

## Evidence Rows

- Backend/API route evidence: focused route tests cover JSON export, CSV export, date filters, cross-org denial, empty campaign DTOs, token mint/revoke, public token access, expired token denial, and revoked token denial.
- Domain artifacts: `report.json` and `report.csv` are the generated export artifacts and were manually reviewed.
- Frontend screenshots/video: N/A - this PR adds API export/public-link routes and service DTOs only; no dashboard UI was changed.
- Real LLM trajectory: N/A - this change does not alter agent prompt/model/action/provider behavior. Scenario-runner currently targets agent conversation/runtime scenarios, not cloud API export routes.
- Native/mobile/audio/on-chain evidence: N/A - no native, voice, wallet, or chain behavior changed.
