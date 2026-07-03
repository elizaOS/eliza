# #11364 advertiser onboarding + spend caps

Branch: `fix/11364-ad-spend-caps`

## What changed

- Added `spend_cap_credits` to `ad_accounts` and `ad_campaigns`.
- Added account-level cap updates through `PATCH /api/v1/advertising/accounts/:id`, restricted to org owners/admins.
- Added campaign-level caps to campaign create/update payloads and responses.
- Enforced caps before campaign budget allocation/increase debits credits or calls providers.
- Extended the SSP impression debit transaction so active campaign/account cap checks fail closed on internal ad-serving spend.

## Validation

```bash
bun run install:light
bun run --cwd packages/core build
bun test packages/cloud/shared/src/lib/services/__tests__/ad-account-approval.test.ts packages/cloud/shared/src/lib/services/__tests__/ad-campaign-credit-reconciliation.test.ts
bun test packages/cloud/api/__tests__/advertising-account-admin-routes.test.ts
bun test packages/cloud/shared/src/lib/services/__tests__/ad-inventory.test.ts
bun run --cwd packages/cloud/shared db:check-migrations
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
bunx @biomejs/biome check --write <touched files>
git diff --check
```

Results:

- Shared advertising approval/spend-cap + campaign credit reconciliation suites: 33 pass / 0 fail.
- API account admin route suite: 7 pass / 0 fail.
- Ad inventory SSP PGlite suite: 17 pass / 0 fail.
- Migration check: pass.
- Cloud shared typecheck: pass.
- Cloud API typecheck: pass.
- Biome on touched files: pass after formatting.
- Diff whitespace check: pass.

## Evidence notes

Live ad-network evidence is N/A for this PR: the change is local budget/cap enforcement around the credit and SSP debit boundaries, and no external ad-provider credentials were available in this workspace. Provider write calls are intentionally not reached by the cap-breach tests.
