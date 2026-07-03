# Issue #11600 - Campaign Performance Reports

## Scope

- Added organization-scoped campaign performance report APIs for JSON and CSV export.
- Added hash-backed public share tokens with expiration and revocation.
- Added SDK methods and the `EXPORT_AD_CAMPAIGN_REPORT` cloud-app action.
- Added the `ad_report_shares` migration, schema, and repository.
- Added manually reviewed JSON and CSV export artifacts under
  `.github/issue-evidence/11600-campaign-performance-reports/`.

## Evidence Captured

- `bun run --cwd packages/cloud/api codegen`
  - Regenerated `packages/cloud/api/src/_router.generated.ts` with the report and share routes mounted.
  - Clean rebased run mounted 631 routes with 0 unconverted route files.
- `node packages/cloud/sdk/scripts/generate-public-routes.mjs`
  - Regenerated `packages/cloud/sdk/src/public-routes.ts` with the new public report endpoint metadata.
  - Clean rebased run generated 520 endpoint entries.
- `bun test --isolate --coverage-reporter=lcov packages/cloud/shared/src/lib/services/__tests__/ad-campaign-performance-report.test.ts packages/cloud/api/__tests__/advertising-campaign-report-route.test.ts packages/cloud/api/__tests__/middleware-auth-public-token-paths.test.ts plugins/plugin-cloud-apps/__tests__/ad-campaigns.test.ts`
  - Passed 28/28 tests with 83 assertions.
  - Covered server-side metric calculation, cross-org denial, CSV escaping, hash-backed token creation, expired/revoked tokens, authenticated JSON/CSV export, date-range validation, share creation/revocation, public unauthenticated access, global auth allowlist behavior, and the cloud-app export/share action through the SDK boundary.
- `bun run --cwd packages/cloud/shared db:check-migrations`
  - Passed after renumbering the report-share migration to `0169_ad_report_shares.sql` on top of the existing `0168_cloud_files.sql`.
- `.github/issue-evidence/11600-campaign-performance-reports/report.json`
  - Manually reviewed generated JSON export artifact.
- `.github/issue-evidence/11600-campaign-performance-reports/report.csv`
  - Manually reviewed generated CSV export artifact.
- `.github/issue-evidence/11600-campaign-performance-reports/review.md`
  - Records artifact review notes and N/A evidence rows.
- `git diff --check`
  - Passed.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bun run --cwd packages/cloud/api typecheck`
  - Passed.
- `bun run --cwd packages/cloud/sdk typecheck`
  - Passed.
- `bun run --cwd plugins/plugin-cloud-apps typecheck`
  - Did not pass in this isolated worktree due existing package-resolution failures for `@elizaos/core` / `@elizaos/cloud-sdk` plus unrelated pre-existing implicit-any errors across plugin actions. The focused plugin action suite above passed under `BUN_OPTIONS='--conditions=eliza-source'`.

## Evidence Not Applicable / Not Captured

- UI screenshots/video: N/A - this change adds API, SDK, DB, and agent action surfaces only; no app UI changed.
- Live ad-provider reports: Not captured locally because provider credentials and a provisioned campaign are not available in this workspace. The service path uses existing `getCampaignMetrics`, and route/service tests cover both stored/local campaign totals and provider-refresh boundaries through existing advertising abstractions.
- Live LLM trajectory: Not captured locally because provider keys are unavailable. The cloud-app action has deterministic handler coverage for extraction-free structured input and SDK calls.
