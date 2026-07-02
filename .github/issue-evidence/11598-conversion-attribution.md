# 11598 conversion attribution evidence

Date: 2026-07-02
Worktree: `/home/shaw/eliza-worktrees/11598-conversion-attribution`

## What changed

- Added first-party ad attribution DB tables for deterministic UTM links and deduped conversion events.
- Added signed campaign attribution tokens, UTM link creation, conversion recording, and first-party analytics rollup.
- Added authenticated install route:
  - `GET /api/v1/advertising/campaigns/:id/attribution`
  - `POST /api/v1/advertising/campaigns/:id/attribution`
- Added public conversion pixel/webhook route:
  - `GET /api/v1/advertising/conversions/track`
  - `POST /api/v1/advertising/conversions/track`
- Added SDK and `plugin-cloud-apps` agent action `GET_AD_CAMPAIGN_ATTRIBUTION` for copying install instructions without dashboard UI changes.

## Verification

All Bun tests below were run with a temporary config at `/tmp/eliza-bunfig-no-coverage.toml` containing `coverage = false`; repo-wide Bun coverage reporting hangs after these focused tests finish, while assertions pass and exit cleanly with coverage disabled.

```bash
bun --config=/tmp/eliza-bunfig-no-coverage.toml test packages/cloud/api/__tests__/advertising-conversion-attribution-route.test.ts
# 4 pass, 0 fail

bun --config=/tmp/eliza-bunfig-no-coverage.toml test packages/cloud/shared/src/lib/services/__tests__/ad-conversion-attribution.test.ts
# 4 pass, 0 fail

bun --config=/tmp/eliza-bunfig-no-coverage.toml test plugins/plugin-cloud-apps/__tests__/ad-attribution.test.ts plugins/plugin-cloud-apps/__tests__/ad-inventory.test.ts
# 8 pass, 0 fail

bun run --cwd packages/cloud/shared typecheck
# pass

bun run --cwd packages/cloud/api typecheck
# pass

bun run --cwd packages/cloud/sdk typecheck
# pass

bun run --cwd plugins/plugin-cloud-apps typecheck
# pass

bunx biome check <touched files>
# pass, no fixes applied

git diff --check
# pass
```

## Evidence Matrix

- Backend route behavior: covered by `advertising-conversion-attribution-route.test.ts`, including install payload, public pixel GET, webhook POST dedupe response, and invalid-token rejection.
- DB rows/domain artifacts: represented by migration `0166_ad_conversion_attribution.sql` and repository/service tests for insertion, dedupe, UTM reuse, and rollup.
- Network request: represented by Hono route tests issuing real GET/POST requests against mounted routes.
- Analytics DTO: covered by service rollup test and `campaigns/:id/analytics` DTO fields.
- Agent trigger: covered by `GET_AD_CAMPAIGN_ATTRIBUTION` action tests.
- UI screenshots/video: N/A - no dashboard UI files changed.
- Real-LLM trajectory: N/A for this code slice - the added agent action is deterministic SDK plumbing with no prompt/model behavior changes.
