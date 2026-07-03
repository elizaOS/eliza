# Issue #11600 Campaign Performance Reports

Manual review date: 2026-07-03

## Artifacts Reviewed

- `report.json`: opened and checked campaign identity, platform/provider IDs, date range, spend, impressions, clicks, conversions, CTR/CPC/CPM, budget, and conversion summary fields.
- `report.csv`: opened and checked that the same server-computed DTO fields export as CSV, including escaping for the comma in `Launch, Report`.
- Confirmed neither artifact exposes raw ad-account credentials, access tokens, share-token hashes, or provider secrets.

## Validation Rows

- Backend/API route evidence: focused route tests cover authenticated JSON export, CSV export, date filters, share creation, share revocation, public token access, and expired-token denial.
- Service evidence: focused service tests cover server-side metric calculation, cross-org denial, CSV escaping, hash-backed token creation, expired shares, and revoked shares.
- Domain artifacts: `report.json` and `report.csv` are committed generated export artifacts and were manually reviewed.
- Frontend screenshots/video: N/A - this PR adds API, SDK, DB, and agent-action export/share surfaces without changing dashboard UI.
- Live ad-provider report evidence: not captured locally because provider credentials and a provisioned campaign are unavailable.
- Real LLM trajectory: not captured locally because provider keys are unavailable. The cloud-app action is covered through deterministic handler tests against the SDK boundary.
- Native/mobile/audio/on-chain evidence: N/A - no native, voice, wallet, or chain behavior changed.
