# Issue #11663 - LinkedIn Ads Provider

## Scope

- Added `linkedin` as an advertising platform in shared schemas (`AdPlatformSchema`), DB typing
  (`AdPlatform`, LinkedIn `organization_urn` metadata), credit spend markup, the provider
  registry, and the app promotion route platform validation.
- Added a real LinkedIn Marketing API provider (`providers/linkedin.ts`) using the versioned
  REST gateway (`api.linkedin.com/rest`, `LinkedIn-Version` + `X-Restli-Protocol-Version: 2.0.0`
  headers, OAuth2 bearer tokens):
  - account discovery via the `adAccounts` search finder (Rest.li structured query)
  - campaign creation as campaign group + paused campaign (`x-restli-id` id extraction),
    with objective mapping, daily/total budget mapping, worldwide-default geo targeting
    (`urn:li:geo` URNs pass through; free-text locations fail loudly), and auto-bid
    `costType`/`optimizationTargetType` mapping per the documented allowable combinations
  - campaign update/pause/activate/delete via Rest.li `PARTIAL_UPDATE` patches
    (`PENDING_DELETION` for non-draft deletes)
  - media upload through the Images/Videos APIs (`initializeUpload` -> byte upload ->
    `finalizeUpload` for multi-part video), owner resolved from the ad account's
    organization `reference`
  - creative creation as an inline dark post (`creatives?action=createInline`) with
    CTA label + landing page mapping
  - analytics via the `adAnalytics` analytics finder (CAMPAIGN pivot, explicit `fields`)
  - OAuth2 `refresh_token` grant against `www.linkedin.com/oauth/v2/accessToken`
- #11621 bid controls map to LinkedIn `costType`/`optimizationTargetType`
  (`cpm`->CPM, `cpc`->CPC, `cpa`->CPM+MAX_CONVERSION; goals reach/clicks/conversions ->
  MAX_IMPRESSION/MAX_CLICK/MAX_CONVERSION; objective-default auto-bid otherwise) and never
  emit a manual `unitCost`.
- Added a credential-gated live lane in `linkedin.real.test.ts` that logs a loud SKIP when
  `LINKEDIN_ADS_ACCESS_TOKEN` is absent.

## Official Docs Reviewed (fixtures lifted from these pages)

- Ad accounts: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts
- Campaign groups: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups
- Campaigns: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns
- Creatives (inline dark posts): https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives
- Images API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
- Reporting (adAnalytics): https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting
- Objective/bid combinations: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ad-budget-pricing-type-combinations

Test fixtures (account search response, ad account fetch, image GET, adAnalytics elements,
`x-restli-id` header ids, `urn:li:sponsoredCreative:120491345`) are copied from the sample
responses on those pages, not invented.

## Verification

- `bun test packages/cloud/shared/src/lib/services/advertising/providers/linkedin.test.ts`
  - 16 pass / 0 fail (78 expect() calls). Covers account discovery + validation, campaign
    create mapping (daily + lifetime budgets), bid-control mapping, geo-targeting
    validation (fail-fast before any platform call), Rest.li partial updates for
    pause/activate/delete, budget-field-aware updates, inline creative payload,
    media status, analytics summation, and API error propagation.
  - Service integration block drives `advertisingService.createCampaign` with the REAL
    LinkedIn provider and a mocked `fetch`:
    - #11619 approval gate: a `pending` LinkedIn account is rejected before content
      safety, credits, or any LinkedIn API call.
    - #11621 bid metadata: `bid_strategy`/`optimization_goal` persist to campaign
      metadata and the provider payload carries `costType: CPC` +
      `optimizationTargetType: MAX_CLICK`.
    - Fail-closed money path: a LinkedIn 403 on campaign-group create fails the service
      call, persists nothing, and refunds the full charge (0.5 + 50 * 1.1 credits) once.
- `bun test packages/cloud/shared/src/lib/services/__tests__/ad-account-approval.test.ts ad-campaign-bid-strategy.test.ts ad-campaign-dayparting.test.ts ad-campaign-credit-reconciliation.test.ts ad-audience-segments.test.ts ad-conversion-attribution.test.ts`
  - 58 pass / 0 fail across 6 files (existing suites unaffected by the platform addition).
- `bun test packages/cloud/api/__tests__/advertising-*.test.ts` - 14 pass / 0 fail.
- `bun test packages/cloud/shared/src/lib/services/advertising/providers/linkedin.real.test.ts`
  - 2 skip with a loud `[LinkedInAdsRealTest] SKIPPED: set LINKEDIN_ADS_ACCESS_TOKEN ...`
    warning (no live credentials in this environment).
- `bun run --cwd packages/cloud/shared typecheck` - passed (after
  `node packages/shared/scripts/generate-keywords.mjs --target ts`, environmental).
- `bun run --cwd packages/cloud/api typecheck` - passed.
- `bunx biome check` on all touched files - clean.

## Manual Review

- Compared every provider URL, header, Rest.li query encoding, request body, and response
  parsing against the Microsoft Learn LinkedIn Marketing API pages listed above.
- Reviewed mocked `fetch` call URLs, `X-RestLi-Method` headers, and JSON payload assertions
  in `linkedin.test.ts` by hand.

## Not Captured

- Live LinkedIn Marketing API run: N/A in this environment - LinkedIn Ads API access
  requires a LinkedIn developer application with the Advertising API product approved plus
  a member token with `rw_ads`; no such operator credentials are provisioned. The live lane
  runs when `LINKEDIN_ADS_ACCESS_TOKEN` (and optionally `LINKEDIN_ADS_ACCOUNT_ID`,
  `LINKEDIN_ADS_CLIENT_ID`/`LINKEDIN_ADS_CLIENT_SECRET` for token refresh) are set.
- Screenshots/video: N/A - no UI rendering change.
- Real-LLM trajectories: N/A - no agent/action/prompt/model behavior change.
