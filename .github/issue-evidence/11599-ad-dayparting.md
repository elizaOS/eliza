# Issue 11599 - Cloud Advertising Dayparting

## Implementation Proof

- Added typed campaign dayparting windows with timezone validation, day-of-week validation, local `HH:mm` bounds, and duplicate-day rejection.
- Added campaign create/update persistence through ad campaign metadata, including local draft updates before provider sync.
- Added Meta ad set schedule mapping for supported create payloads.
- Added duplicate campaign service/route support that creates a draft local copy, copies creatives, and strips provider runtime state, spend, analytics, and billing/provider identifiers.
- Added cloud SDK methods and cloud-apps agent actions for setting dayparting and duplicating campaigns.

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
