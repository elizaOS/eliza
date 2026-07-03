# Issue 11599 - Cloud Advertising Dayparting

## Implementation Proof

- Added typed campaign dayparting windows with timezone validation, day-of-week validation, local `HH:mm` bounds, and duplicate-day rejection.
- Added campaign create/update persistence through ad campaign metadata, including local draft updates before provider sync.
- Added Meta ad set schedule mapping for supported create payloads.
- Added duplicate campaign service/route support that creates a draft local copy, copies creatives, and strips provider runtime state, spend, analytics, and billing/provider identifiers.
- Added cloud SDK methods and cloud-apps agent actions for setting dayparting and duplicating campaigns.

### Review fixes (2026-07-02)

- **Serving-path enforcement**: the first-party SSP serve path (`adInventoryService.serveAd` → `adSlotsRepository.findEligibleAds`) now gates ad selection on the campaign's dayparting windows, evaluated in the schedule's own IANA timezone (`isWithinDayparting`, `services/advertising/dayparting.ts`). Previously the schedule was advisory: an out-of-window campaign was still served and billed 24/7 through `/api/v1/marketing/inventory/serve`. A corrupt stored schedule fails CLOSED (skipped, never billed). Proven by two new PGlite end-to-end tests in `ad-inventory.test.ts` (out-of-window campaign not served/billed; in-window campaign wins over a richer out-of-window competitor).
- **Truthful `dayparting_provider_synced_at` semantics** (reconciled with the fail-closed follow-up commit): the marker is stamped only at CREATE, where the schedule genuinely goes into the Meta payload; non-Meta creates with dayparting are rejected before charging; post-sync dayparting changes are rejected (`create or duplicate a scheduled campaign instead`) since no provider `updateCampaign` can push `adset_schedule`; duplicates strip the marker (a copy is not provider-synced). The previously unreachable synced-path metadata stamping was removed as dead code.
- **Unsynced campaigns reject mixed updates**: updating an unsynced campaign with `dayparting` plus other fields (name/budget/dates/targeting) now throws instead of silently applying only the schedule and dropping the rest.
- **`"24:00"` end-of-day**: `endTime` accepts `24:00` (exclusive) so a window can cover a full local day — previously `23:59` max meant the last minute of any day was untargetable. Matches Meta's `end_minute: 1440`.
- Added fixed-instant unit tests for `isWithinDayparting` proving evaluation happens in the schedule timezone (not UTC/server-local) and that bounds are half-open `[start, end)`.

## Verification Commands

All commands were run from `/home/shaw/eliza-worktrees/11599-ad-dayparting`.

```bash
bun --config=/tmp/eliza-bunfig-no-coverage.toml test packages/cloud/shared/src/lib/services/__tests__/ad-campaign-dayparting.test.ts
bun --config=/tmp/eliza-bunfig-no-coverage.toml test packages/cloud/api/__tests__/advertising-campaign-dayparting-route.test.ts
bun --config=/tmp/eliza-bunfig-no-coverage.toml test plugins/plugin-cloud-apps/__tests__/ad-campaigns.test.ts plugins/plugin-cloud-apps/__tests__/ad-inventory.test.ts
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
bun run --cwd packages/cloud/sdk typecheck
bun run --cwd plugins/plugin-cloud-apps typecheck
git diff --check
bun run verify
```

Result: all commands passed before PR creation.

## Manual Review

- Reviewed the service tests to confirm invalid schedules fail before repository persistence.
- Reviewed the duplicate campaign test output to confirm copied campaigns are `draft`, not provider-synced, and do not retain external creative IDs or spend/analytics state.
- Reviewed route tests to confirm organization scoping is passed to service calls and invalid schedule/name payloads return `400`.
- Reviewed cloud-apps action tests to confirm the agent actions require structured IDs and schedule payloads before calling the SDK.

## Evidence N/A

- Dashboard screenshots/video: N/A - this change adds backend/API/SDK/agent-action surfaces and does not modify `packages/app` UI.
- Live provider logs: N/A - no real advertising provider credentials or staging ad account were available in this local environment; provider payload mapping is covered by deterministic tests.
- Real LLM trajectory: N/A - no prompt/model/provider behavior was changed; the cloud-apps agent actions use structured parameters and are covered by action tests.
