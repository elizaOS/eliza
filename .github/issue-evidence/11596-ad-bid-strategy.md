# Issue #11596 — Advertising Bid Strategy Controls

## Implementation

- Added `bidStrategy` (`cpm`/`cpc`/`cpa`) and `optimizationGoal` (`reach`/`clicks`/`conversions`) to campaign create/update schemas and service types.
- Persisted bid controls in `ad_campaigns.metadata` and returned them from campaign list/detail/create API responses.
- Threaded bid controls through app promotion config and the promotion dialog.
- Mapped controls into Meta ad set and Google campaign create payloads.
- Explicitly rejects TikTok campaign-level bid controls because this adapter only has bid settings on the ad-group path today.
- `updateCampaign` rejects bid-control changes fail-closed (before any credit movement or platform call): no adapter applies bid changes to a live campaign, so persisting them locally would be silent local/platform drift.

## Verification

- `bun test packages/cloud/shared/src/lib/services/__tests__/ad-campaign-bid-strategy.test.ts`
  - 9 tests passed.
- `bunx biome check packages/cloud/shared/src/lib/services/__tests__/ad-campaign-bid-strategy.test.ts packages/cloud/shared/src/lib/services/app-promotion.ts packages/ui/src/cloud-ui/components/promotion/promote-app-dialog.tsx packages/cloud/shared/src/lib/services/advertising/providers/meta.ts packages/cloud/shared/src/lib/services/advertising/providers/google.ts packages/cloud/shared/src/lib/services/advertising/providers/tiktok.ts packages/cloud/shared/src/lib/services/advertising/index.ts packages/cloud/shared/src/lib/services/advertising/types.ts packages/cloud/shared/src/lib/services/advertising/schemas.ts packages/cloud/shared/src/db/schemas/ad-campaigns.ts packages/cloud/api/v1/advertising/campaigns/route.ts packages/cloud/api/v1/advertising/campaigns/[id]/route.ts`
  - Passed.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bun run --cwd packages/cloud/api typecheck`
  - Passed.
- `bun run --cwd packages/ui typecheck`
  - Passed.
- `bun run --cwd packages/app audit:app`
  - 348 captures passed.
  - Touched `/apps` route verdicts were `good` for mobile portrait, mobile landscape, desktop landscape, and iPad portrait.
  - Command exited 1 on unrelated existing minimalism ratchet failures:
    - `plugin-inbox-gui @ mobile-landscape`
    - `plugin-screenshare-gui @ mobile-portrait`

## Evidence Gaps

- No live ad-platform campaign was created. Provider behavior is covered with deterministic payload mapping tests; live external ad account spend remains the missing end-to-end evidence.
