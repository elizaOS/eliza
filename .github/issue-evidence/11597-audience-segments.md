# Issue #11597: Cloud advertising audience segments

Branch: `feat/11597-audience-segments`

## Implemented

- Added `ad_audience_segments` storage with organization scoping, creator attribution, server-owned targeting JSON, metadata, timestamps, and migration `0166_ad_audience_segments.sql`.
- Added advertising service APIs for list/get/create/update/delete/apply audience segments.
- Added REST routes:
  - `GET|POST /api/v1/advertising/audience-segments`
  - `GET|PATCH|DELETE /api/v1/advertising/audience-segments/:id`
  - `POST /api/v1/advertising/audience-segments/:id/apply`
- Added `audienceSegmentId` support to campaign create/update and app promotion advertising config. Requests reject sending both raw `targeting` and `audienceSegmentId`.
- Added validation for age ranges, gender combinations, and bounded deduped targeting arrays.
- Added Meta provider mapping for saved segment targeting fields: locations, age, genders, interests, behaviors, custom audiences, excluded audiences, placements, and languages. Google/TikTok providers are unchanged because their current campaign adapters do not apply targeting payloads.
- Added a saved-segment selector to the app promotion advertising tab.

## API examples

Create segment:

```json
POST /api/v1/advertising/audience-segments
{
  "name": "US product launch",
  "targeting": {
    "locations": ["US"],
    "ageMin": 21,
    "ageMax": 45,
    "genders": ["all"],
    "interests": ["ai agents"],
    "customAudiences": ["launch-list"]
  }
}
```

Apply segment:

```json
POST /api/v1/advertising/audience-segments/{segmentId}/apply
{
  "campaignId": "{campaignId}"
}
```

Create campaign from segment:

```json
POST /api/v1/advertising/campaigns
{
  "adAccountId": "{adAccountId}",
  "name": "Launch campaign",
  "objective": "traffic",
  "budgetType": "daily",
  "budgetAmount": 100,
  "audienceSegmentId": "{segmentId}"
}
```

## Verification

- `bun install` passed in the issue worktree.
- `bun run build:core` passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/ad-audience-segments.test.ts` passed: 4 tests, 11 assertions.
- `bunx biome check --write ...` passed on touched files.
- `bun run --cwd packages/cloud/shared typecheck` passed.
- `bun run --cwd packages/cloud/api typecheck` passed.
- `bun run --cwd packages/ui typecheck` passed.
- `git diff --check` passed.
- `bun run --cwd packages/cloud/api codegen` regenerated `packages/cloud/api/src/_router.generated.ts`.

## App visual audit

`bun run --cwd packages/app audit:app` was run after the promotion dialog UI change.

Result: 348 of 349 Playwright view checks passed. The command exited 1 on the final aggregate ratchet gate for two unrelated pre-existing minimalism regressions:

- `plugin-inbox-gui @ mobile-landscape`: whitespace ratio `0.53 < baselined 0.56 - 5% tolerance (0.53)`
- `plugin-screenshare-gui @ mobile-portrait`: whitespace ratio `0.45 < baselined 0.48 - 5% tolerance (0.46)`

The touched reachable `/apps` views passed across mobile portrait, mobile landscape, desktop landscape, and iPad portrait during this run.

## N/A evidence

- Live LLM trajectory: N/A - this change does not alter prompt, model, provider, evaluator, or agent reasoning behavior.
- Live ad provider spend/campaign creation: N/A - the provider call path is covered by service tests with provider adapter stubs; no live ad account credentials or campaign spend were used in this local validation.
- Video walkthrough: N/A - the dashboard change is a selector in an existing promotion dialog; the full app audit screenshots were captured by `audit:app`, but the command failed only on unrelated views listed above.
