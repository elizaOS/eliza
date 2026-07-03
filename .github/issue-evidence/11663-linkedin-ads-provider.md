# Issue #11663 - LinkedIn Ads Provider

## Summary

Implemented the `linkedin` advertising provider for the Cloud advertising service:

- LinkedIn Marketing API account discovery and credential validation.
- Paused campaign creation under an existing or newly created campaign group, including required LinkedIn campaign fields for locale, cost type, targeting criteria, offsite delivery, and political intent.
- Campaign update, pause, activate, and archive lifecycle operations through Rest.li patch bodies.
- Text ad creative creation.
- Image upload initialization, binary upload, and media library registration.
- Campaign analytics mapping from LinkedIn `adAnalytics` rows into Cloud campaign metrics.
- Platform validation updates for shared schemas and the app promotion route.

## Official API References

- LinkedIn Marketing API overview: https://learn.microsoft.com/en-us/linkedin/marketing/?view=li-lms-2026-06
- Ad accounts: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-06
- Campaign groups: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-06
- Campaigns: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-06
- Creatives: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-06
- Ads reporting: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-06
- Images API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-06

## Verification

- `bun test packages/cloud/shared/src/lib/services/advertising/providers/linkedin.test.ts packages/cloud/shared/src/lib/services/advertising/providers/linkedin.real.test.ts`
  - Result: 9 pass, 1 skipped live test.
- `bun run --cwd packages/cloud/shared typecheck`
  - Result: pass.
- `bun run --cwd packages/cloud/api typecheck`
  - Result: pass.
- `bunx biome check packages/cloud/shared/src/lib/services/advertising/providers/linkedin.ts packages/cloud/shared/src/lib/services/advertising/providers/linkedin.test.ts packages/cloud/shared/src/lib/services/advertising/providers/linkedin.real.test.ts packages/cloud/shared/src/lib/services/advertising/index.ts packages/cloud/shared/src/lib/services/advertising/types.ts packages/cloud/shared/src/lib/services/advertising/schemas.ts packages/cloud/shared/src/db/schemas/ad-accounts.ts 'packages/cloud/api/v1/apps/[id]/promote/route.ts'`
  - Result: pass.
- `git diff --check`
  - Result: pass.

## Live Lane

`packages/cloud/shared/src/lib/services/advertising/providers/linkedin.real.test.ts` is gated by `LINKEDIN_ADS_LIVE_TEST=1` and fails loudly if that flag is set without `LINKEDIN_ADS_ACCESS_TOKEN`.

Live LinkedIn credentials were not available in this environment, so no production LinkedIn account was touched and no live campaign was created.

## Evidence Matrix

- Real provider mocked tests: complete.
- Live provider lane: present, skipped because credentials are unavailable.
- Backend logs: N/A - mocked provider tests assert outbound requests directly; no server was run.
- Frontend screenshots/video: N/A - no UI rendering changed.
- Real LLM trajectories: N/A - no model, prompt, action, or provider behavior changed.
- Domain artifacts: N/A - no real LinkedIn account credentials were available, so no provider-side account, campaign, creative, or image asset was created.
