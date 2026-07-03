# Issue #11661 - Reddit Ads Provider

## Scope

- Added `reddit` as an advertising platform in shared schemas, DB typing, credit markup, the advertising provider registry, and the app promotion route schema.
- Added a Reddit Ads API v3 provider using the official endpoints for:
  - business/account discovery via `/me/businesses` and `/businesses/{business_id}/ad_accounts`
  - campaign create/update/archive via `/ad_accounts/{ad_account_id}/campaigns` and `/campaigns/{campaign_id}`
  - ad group create/status updates via `/ad_accounts/{ad_account_id}/ad_groups` and `/ad_groups/{ad_group_id}`
  - profile post + ad creative creation via `/profiles/{profile_id}/posts` and `/ad_accounts/{ad_account_id}/ads`
  - campaign metrics via `/ad_accounts/{ad_account_id}/reports`
- Reddit docs used: https://ads-api.reddit.com/docs/v3/ and https://ads-api.reddit.com/api/v3/openapi.json

## Verification

- `bun test packages/cloud/shared/src/lib/services/advertising/providers/reddit.test.ts` - passed 5 tests.
- `bun run --cwd packages/cloud/shared typecheck` - passed after generating local i18n keyword data with `node packages/shared/scripts/generate-keywords.mjs --target ts`.
- `bun run --cwd packages/cloud/api typecheck` - passed.
- `bunx biome check packages/cloud/shared/src/lib/services/advertising/providers/reddit.ts packages/cloud/shared/src/lib/services/advertising/providers/reddit.test.ts packages/cloud/shared/src/lib/services/advertising/index.ts packages/cloud/shared/src/lib/services/advertising/types.ts packages/cloud/shared/src/lib/services/advertising/schemas.ts packages/cloud/shared/src/db/schemas/ad-accounts.ts 'packages/cloud/api/v1/apps/[id]/promote/route.ts'` - passed.

## Manual Review

- Reviewed the generated provider request bodies against the Reddit Ads API v3 OpenAPI for campaign, ad group, post, ad, profile, business account, and report endpoints.
- Reviewed mocked `fetch` call URLs and bodies in `reddit.test.ts` to confirm the provider drives real Reddit API paths rather than local-only stubs.

## Not Captured

- Live Reddit Ads trajectory: N/A in this environment because no Reddit Ads OAuth token/business/ad account credentials are available to the agent. The provider tests cover the real documented HTTP contract with mocked network responses.
- Screenshots/video: N/A. This change does not alter UI rendering.
