# Issue #11662 - X / Twitter Ads Provider

## Scope

- Added `x-twitter` as an advertising platform in shared schemas, DB typing, credit markup, provider registry, and app promotion route validation.
- Added a real X Ads API v12 provider with OAuth 1.0a signing for:
  - account discovery via `GET /12/accounts`
  - funding instrument lookup
  - campaign creation and lifecycle updates
  - line item creation and lifecycle updates
  - Tweet creation and `promoted_tweets` association
  - media upload to `upload.x.com` plus media library registration
  - line-item stats mapping from `GET /12/stats/accounts/:account_id`
- Added a credential-gated live lane in `x-twitter.real.test.ts`. It skips
  unless `X_ADS_LIVE_TEST=1`, then fails with the exact missing credential names
  if the X Ads consumer/token values are not set.

## Official Docs Reviewed

- X Ads introduction: https://docs.x.com/x-ads-api/introduction
- X Ads hierarchy: https://docs.x.com/x-ads-api/fundamentals/hierarchy-and-terminology
- OAuth 1.0a authenticated requests: https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests
- Campaign management reference: https://docs.x.com/x-ads-api/campaign-management/reference
- Creatives reference: https://docs.x.com/x-ads-api/creatives/reference
- Analytics docs: https://docs.x.com/x-ads-api/analytics

## Verification

- `bun test packages/cloud/shared/src/lib/services/advertising/providers/x-twitter.test.ts` - passed mocked provider tests.
- `bun test packages/cloud/shared/src/lib/services/advertising/providers/x-twitter.real.test.ts` - skipped visibly by default because `X_ADS_LIVE_TEST=1` was not set.
- `bun run --cwd packages/cloud/shared typecheck` - passed after generating local i18n keyword data with `node packages/shared/scripts/generate-keywords.mjs --target ts`.
- `bun run --cwd packages/cloud/api typecheck` - passed.
- Biome check on touched files - passed.

## Manual Review

- Reviewed the provider URLs and request parameters against the official X Ads Markdown docs for accounts, funding instruments, campaigns, line items, tweets, promoted tweets, media library, OAuth signing, and stats.
- Reviewed mocked `fetch` call URLs, query parameters, and OAuth Authorization header assertions in `x-twitter.test.ts`.
- Reviewed creative media ordering so request payloads are sorted without mutating the caller's media array.

## Not Captured

- Live X Ads run: N/A in this environment because the agent does not have X Ads API approval credentials, consumer secret, access token, and token secret. The live lane will run when `X_ADS_LIVE_TEST=1`, `X_ADS_CONSUMER_KEY`, `X_ADS_CONSUMER_SECRET`, `X_ADS_ACCESS_TOKEN`, and `X_ADS_ACCESS_TOKEN_SECRET` are set.
- Screenshots/video: N/A. This change does not alter UI rendering.
- Real-LLM trajectories: N/A. No agent/action/prompt/model behavior changed.
