# #9970 — iOS coarse-summary screen-time ingestion (criterion #4)

Implements the consumer side of criterion #4: ingest iOS **coarse** screen-time
into the same screen-time read path as Android, **only when authorization is
approved**, while keeping `rawUsageExportAvailable: false` as a permanent Apple
constraint (documented in #10178).

## What changed

- `plugins/plugin-health/src/screen-time/mobile-signals.ts` —
  `iosCoarseUsageRowsFromSignals(signals, sinceMs, untilMs)`, a parallel to the
  existing `androidUsageRowsFromSignals`. It reads coarse **category** summaries
  off `metadata.screenTime.categories` and emits `ScreenTimeAggregateRow`s
  (`source: "app"`, `identifier: "ios.category.<id>"`, `metadata.platform: "ios"`),
  gated on:
  - `authorization.status === "approved"`,
  - `coarseSummaryAvailable === true`,
  - `rawUsageExportAvailable !== true` (raw per-app export is never ingested — a
    permanent platform constraint).
- `plugins/plugin-personal-assistant/src/lifeops/domains/screentime-service.ts` —
  wires it into `collectScreenTimeRows`'s `source: "app"` block, immediately
  after the Android reader, filtering the same `listActivitySignals` result to
  `platform === "ios"` within the window.

## Design notes

- Apple's DeviceActivity / FamilyControls model only exposes coarse,
  in-extension-rendered **category** summaries to the host — never raw per-app
  usage. The reader therefore ingests category totals, not per-window dwell, and
  refuses any signal that claims `rawUsageExportAvailable: true`.
- The reader is **inert until a native iOS producer emits
  `metadata.screenTime.categories`** — the contract mirrors the host-side coarse
  model (category identifier + total active time, `totalSeconds` or `totalMs`).
  No existing signal carries that field, so production behavior is unchanged
  until the producer lands; the spine already accepts the `mobile_health`
  signals that would carry it.

## Verification

- `vitest run src/screen-time/mobile-signals.test.ts` → **8 passed** (3 new):
  - approved coarse categories → aggregated `ios.category.*` rows;
  - `denied` / `not-determined` / `unavailable` auth → no rows;
  - `coarseSummaryAvailable: false` → no rows;
  - `rawUsageExportAvailable: true` → no rows (constraint).
- `tsc --noEmit` (plugin-health) → **0 errors in the reader**; the 2 remaining
  worktree errors are unbuilt `@elizaos/capacitor-*` `.d.ts` in `packages/ui`,
  untouched by this PR.
- `biome check` → clean.

## Evidence types (per PR_EVIDENCE.md)

- **Real-LLM trajectory:** N/A — pure data-ingestion read path, no model.
- **Backend logs:** N/A — the reader emits rows; covered by unit tests with
  injected signals (the only way to exercise it on a non-iOS host).
- **Frontend / screenshots / video / audio:** N/A — no UI/voice surface; the
  rows flow into the existing screen-time read path already rendered by the
  dashboard.
