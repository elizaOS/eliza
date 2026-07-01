# #10196 — real-app `audit:views` lifecycle soak

Current run: local real app stack on 2026-06-30.

```bash
UI=http://127.0.0.1:2140 API=http://127.0.0.1:3140 ROUNDS=2 NAV_WAIT_MS=500 \
  node packages/app/scripts/audit-views-soak.mjs
```

## Result

PASS against the real app, not a synthetic fixture.

- Registered views enumerated from `/api/views`: 22 total
  - system: 8
  - preview: 6
  - developer: 6
  - plugin: 2
- Activations: 44 (2 rounds across every registered view)
- First-run setup: already complete; 0 visible chooser blocks
- Navigation: 22/22 view paths reached
- Runtime telemetry: 33 real `show` events
- Worst per-view render count: 1
- Render-loop guard errors: 0
- Module cache evictions after churn/release: 32
- Scorecard-attributed module evictions: 58
- Heap series: 225.2 MB -> 213.4 MB -> 214.7 MB (1.01x warm ratio, below 2.2x budget)
- Uncaught page errors: 0

## Artifacts

- Machine summary: `audit-views-soak.json`
- Per-view scorecard: `audit-views-scorecard.md` and `audit-views-scorecard.json`
- Raw telemetry rings:
  - `audit-views-render-telemetry.json`
  - `audit-views-runtime-telemetry.json`
  - `audit-views-module-cache-telemetry.json`
  - `audit-views-heap-series.json`
  - `audit-views-navigation.json`
  - `audit-views-frontend-log.json`
  - `audit-views-network-log.json`
- Screen recording: `audit-views-soak.webm`
- Screenshots: `view-*.png`, `soak-final.png`, `audit-views-logs-loaded.png`, `audit-views-settings.png`

Manual review notes:

- `audit-views-logs-loaded.png` shows the loaded Logs view after the hydration
  stabilization; no skeleton collapse or visible row overlap remained.
- `audit-views-settings.png` shows the Settings title after reserving space for
  the global back button; no title/button overlap remained.
- The scorecard and raw navigation log confirm `/character/documents` reached
  both rounds without the previous fetch/render loop.
