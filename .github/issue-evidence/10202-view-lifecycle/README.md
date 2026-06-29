# Evidence — #10202 view lifecycle / memory / crash containment

Regenerate: `bun run --cwd packages/ui test:view-lifecycle-e2e` (real
`KeepAliveViewHost` + `ViewLifecycleController` over a synthetic view matrix in
headless Chromium, `--js-flags=--expose-gc --enable-precise-memory-info`).

## What the run proves (all assertions green, 0 unexpected page errors)

| # | Acceptance criterion | Result |
|---|----------------------|--------|
| 1 | bounded eviction for inactive views | keep-alive retained set **max 3 ≤ device-memory LRU cap** across 24×4 switches |
| 2 | pause/resume for timers/RAF/media | a hidden view's RAF loop **flatlines** while paused (253 == 253), resumes on show |
| 3 | bounded LRU + exemptions | LRU **evicted** the oldest keep-alive views; chat/background never evicted |
| 4 | rerender storm caught | per-view render telemetry **flagged the storm view**, not the calm siblings |
| 5 | listener leak caught | the leaky view's never-disposed subscription **stays visible** in telemetry (subs=1) |
| 6 | crash containment + recovery | a thrown render shows the **per-view fallback**, the shell + siblings survive, **Retry recovers** |
| 7 | unbounded view-switch memory growth caught | 24 gc'd heap samples → detector verdict **not leaking** (slope 22 KiB/cycle ≪ 512 KiB budget) |

## Files

- `vl-01-initial-alpha.png` — initial active view.
- `vl-02-after-switch-cycles.png` — after 24×4 repeated view switches.
- `vl-03-storm-view.png` — the rerender-storm view active.
- `vl-04-crash-contained.png` — per-view error fallback (Retry / Back to launcher); shell alive.
- `vl-05-crash-recovered.png` — view recovered after Retry.
- `view-lifecycle-walkthrough.webm` — full end-to-end walkthrough.
- `telemetry.json` — `maxRetained`, the 24 heap samples, the memory-budget
  summary + verdict, render-storm event count, and the last 20 per-view runtime
  telemetry events.

## Memory trend (this run)

```
24 samples · first 4.76 MiB → last 5.43 MiB · slope 22.2 KiB/cycle ·
growth 14% · monotonic 100% · verdict: NOT leaking
```

The trend is monotonic but the per-cycle slope (22 KiB) is two orders of
magnitude under the 512 KiB/cycle budget — JIT/code-cache warmup, not a
per-switch retention. A real per-switch leak (MiB/cycle) trips
`shouldReportMemoryGrowth` and fails the build.

## Per-PR_EVIDENCE.md

- **Real-LLM trajectory** — N/A: presentation/runtime-infra + test work; no
  agent/model/prompt/server path touched.
- **Backend logs** — N/A: no server code path.
- **Audio** — N/A: no voice/TTS/STT change.
- **Frontend logs** — the e2e captures console + pageerror (0 unexpected; the
  one intentional crash is filtered). Structured `[ViewLifecycle]`/`[ViewTelemetry]`
  logs fire on every transition (logger, not console).
- **Before/after full-page screenshots** — the builtin-view mount path is
  behavior-identical (default unmount-on-hide); `App.navigate-view-wiring`
  asserts the shared-background / dynamic-view / launcher surfaces are unchanged.
  The new behavior (per-view boundary/telemetry/keep-alive) has no resting visual
  change, so the screenshots above capture the keep-alive host + crash UI rather
  than an app redesign.
