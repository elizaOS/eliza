# Issue #14385 - Home widget sweep evidence

Draft PR: https://github.com/elizaOS/eliza/pull/14428

## What changed

- Removed resident home declarations for non-MVP/autonomous cards:
  `agent-orchestrator.activity`, `agent-orchestrator.apps`,
  `feed.agent-activity`, `workflow.running`, `finances.alerts`,
  `relationships.attention`, and `inbox.unread`.
- Changed default home widget sinks into non-rendering participation records.
- Updated widget registry tests, launch-host tests, smoke helpers, stories, and
  docs for sparse home.
- Deleted dead home-card components/tests/stories for the removed resident cards.
- Unblocked the required app audit by removing redundant market-view divider
  lines in the Hyperliquid and Polymarket spatial views; the labels remain as
  muted section captions, and the Polymarket detail metrics/outcomes spacing was
  adjusted after manual screenshot review caught mobile-landscape crowding.
- Declared the `@elizaos/tui` workspace dev dependency in both market plugins so
  their spatial view tests resolve from a clean workspace install instead of
  relying on incidental root links.

## Checks run after rebase onto origin/develop

```bash
bun run --cwd packages/ui test -- src/widgets/WidgetHost.home-launch.test.tsx src/widgets/default-home-widget-sink-optins.test.ts src/widgets/home-priority-integration.test.ts src/widgets/registry.defaultWidget.test.ts src/widgets/registry.home.test.ts src/widgets/widget-coverage.test.ts
# 6 files passed, 34 tests passed
```

```bash
bunx @biomejs/biome check packages/app/test/ui-smoke/home-widget-priority.spec.ts plugins/plugin-hyperliquid/src/components/HyperliquidSpatialView.tsx plugins/plugin-polymarket/src/components/PolymarketSpatialView.tsx plugins/plugin-hyperliquid/package.json plugins/plugin-polymarket/package.json
# Checked 5 files. No fixes applied.
```

```bash
git diff --check -- packages/app/test/ui-smoke/home-widget-priority.spec.ts plugins/plugin-hyperliquid/src/components/HyperliquidSpatialView.tsx plugins/plugin-polymarket/src/components/PolymarketSpatialView.tsx
# no whitespace errors
```

```bash
bun run --cwd plugins/plugin-hyperliquid test -- src/components/HyperliquidSpatialView.test.tsx
# 1 file passed, 6 tests passed
```

```bash
bun run --cwd plugins/plugin-polymarket test -- src/components/PolymarketSpatialView.test.tsx
# 1 file passed, 4 tests passed
```

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.nvm/versions/node/v24.15.0/bin/node \
  bun run --cwd packages/app test:e2e -- test/ui-smoke/home-widget-priority.spec.ts
# 1 passed
# HOME_WIDGET_ORDER> ["widget-goals-attention","chat-widget-calendar-upcoming","widget-health-sleep"]
```

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.nvm/versions/node/v24.15.0/bin/node \
  bun run --cwd packages/app audit:app
# 369 passed (22.5m)
# [aesthetic-audit] broken=0 needs-work=6 needs-eyeball=22 good=340
# minimalism-budget-failures=0 minimalism-ratchet-failures=0 density-probe-failures=0
```

```bash
ELIZA_NODE_PATH=/Users/shawwalters/.nvm/versions/node/v24.15.0/bin/node \
  bun run --cwd packages/app test:e2e -- --project=audit-app --grep "plugin-polymarket-gui" test/ui-smoke/all-views-aesthetic-audit.spec.ts
# 4 passed
# [aesthetic-audit] broken=0 needs-work=0 needs-eyeball=0 good=4
# minimalism-budget-failures=0 minimalism-ratchet-failures=0 density-probe-failures=0
```

```bash
rg -n "from \"\\./(agent-activity|automations|finances-alerts|inbox-unread|relationships-attention)\"|from './(agent-activity|automations|finances-alerts|inbox-unread|relationships-attention)'|FINANCES_HOME_WIDGET|INBOX_HOME_WIDGET|RELATIONSHIPS_HOME_WIDGET|AgentActivityWidget|AutomationsWidget" packages/ui/src packages/app/test -g '!packages/ui/src/components/shell/__e2e__/output-home/**' -S
# no matches
```

## Visual evidence

- Home priority screenshots:
  - `packages/app/aesthetic-audit-output/home-widget-priority/desktop.png`
  - `packages/app/aesthetic-audit-output/home-widget-priority/mobile.png`
  - `packages/app/aesthetic-audit-output/home-widget-priority/launcher.png`
- Manual review:
  - Desktop and mobile show the sparse MVP home: one pinned payment-failed
    notification, Goals (`Ship the release`), Calendar (`Design review`), Health
    sleep (`5h 45m`, `Irregular`), weather, quick prompt chips, and the
    persistent `Ask Eliza` composer.
  - Removed resident clutter is absent: no inbox unread, finances alert,
    relationships attention, automations/running workflow, or agent activity
    home cards render.
  - Launcher gesture opens the app grid while keeping the persistent composer
    available.
  - Hyperliquid/Polymarket screenshots were manually re-opened after divider
    cleanup. Hyperliquid mobile portrait is readable with status/markets/account
    captions and no redundant horizontal rules. Polymarket mobile landscape no
    longer crowds the outcomes label into the volume/liquidity row; outcomes are
    below the fold in the short landscape viewport, with the composer clear.

## OCR and color heuristics

OCR was run with `tesseract` over the home priority screenshots.

- Desktop/mobile OCR included `Payment failed`, `Ship the release`, `Design
  review`, `Sleep`, and `Ask Eliza`; launcher OCR is less useful because the
  primary content is iconography, but it still identifies the composer.
- Color sampling via `sharp`:
  - desktop home: `blue_fraction=0`, `orange_fraction=0.8341`,
    `white_fraction=0.0033`.
  - mobile home: `blue_fraction=0`, `orange_fraction=0.3887`,
    `white_fraction=0.0499`.
  - launcher: `blue_fraction=0.011` from icon art only,
    `orange_fraction=0.3491`.
  - hyperliquid mobile portrait: `blue_fraction=0`,
    `orange_fraction=0.0651`, `white_fraction=0.8954`.
  - polymarket mobile landscape: `blue_fraction=0`,
    `orange_fraction=0.0241`, `white_fraction=0.953`.

## Evidence matrix

- Real LLM trajectory: N/A - home UI registry/component cleanup only.
- Backend logs: N/A - no backend path changed.
- Frontend screenshots/video: screenshots captured and manually reviewed as
  listed above; video N/A for this registry/component cleanup PR.
- Domain artifacts: N/A - no DB/memory/files produced by this change.
