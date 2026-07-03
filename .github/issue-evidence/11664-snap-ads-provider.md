# Issue #11664 - Snap Ads Provider

## Summary

Implemented the `snap` advertising provider for the Cloud advertising service:

- Snap Marketing API account discovery through `/me/organizations?with_ad_accounts=true`.
- Paused campaign creation plus paused ad squad creation.
- Campaign/ad squad update, pause, activate, and campaign delete operations.
- Media creation and multipart upload for Snap-hosted image/video assets.
- Web View creative creation plus paused ad creation.
- Campaign stats mapping from Snap microcurrency and delivery metrics into Cloud campaign metrics.
- Platform validation updates for shared schemas and the app promotion route.

## Official API References

- Snap Ads API overview: https://developers.snap.com/marketing-api/Ads-API/introduction
- Organizations and account discovery: https://developers.snap.com/marketing-api/Ads-API/organizations
- Ad accounts: https://developers.snap.com/marketing-api/Ads-API/ad-accounts
- Campaigns: https://developers.snap.com/marketing-api/Ads-API/campaigns
- Ad squads: https://developers.snap.com/marketing-api/Ads-API/ad-squads
- Ads: https://developers.snap.com/marketing-api/Ads-API/ads
- Media: https://developers.snap.com/marketing-api/Ads-API/media
- Creatives: https://developers.snap.com/marketing-api/Ads-API/creatives
- Measurement/stats: https://developers.snap.com/marketing-api/Ads-API/measurement

## Verification

- `bun test packages/cloud/shared/src/lib/services/advertising/providers/snap.test.ts packages/cloud/shared/src/lib/services/advertising/providers/snap.real.test.ts`
  - Result: pass, 7 pass and 1 skipped live test.
- `bun run --cwd packages/cloud/shared typecheck`
  - Result: pass.
- `bun run --cwd packages/cloud/api typecheck`
  - Result: pass.
- `bunx biome check packages/cloud/shared/src/lib/services/advertising/providers/snap.ts packages/cloud/shared/src/lib/services/advertising/providers/snap.test.ts packages/cloud/shared/src/lib/services/advertising/providers/snap.real.test.ts packages/cloud/shared/src/lib/services/advertising/index.ts packages/cloud/shared/src/lib/services/advertising/types.ts packages/cloud/shared/src/lib/services/advertising/schemas.ts packages/cloud/shared/src/db/schemas/ad-accounts.ts 'packages/cloud/api/v1/apps/[id]/promote/route.ts'`
  - Result: pass.
- `git diff --check`
  - Result: pass.

## Live Lane

`packages/cloud/shared/src/lib/services/advertising/providers/snap.real.test.ts` is gated by `SNAP_ADS_LIVE_TEST=1` and fails loudly if that flag is set without `SNAP_ADS_ACCESS_TOKEN`.

Live Snap credentials were not available in this environment, so no production Snap account was touched and no live campaign, ad squad, creative, ad, or media asset was created.

## Evidence Matrix

- Real provider mocked tests: complete.
- Live provider lane: present, skipped because credentials are unavailable.
- Backend logs: N/A - mocked provider tests assert outbound requests directly; no server was run.
- Frontend screenshots/video: N/A - no UI rendering changed.
- Real LLM trajectories: N/A - no model, prompt, action, or provider behavior changed.
- Domain artifacts: N/A - no real Snap account credentials were available, so no provider-side account, campaign, ad squad, creative, ad, or media asset was created.
