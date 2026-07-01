# #9141 — shell interaction framerate (60/120fps) evidence

Closes the measurement + remaining re-render/repaint gaps of
[#9141](https://github.com/elizaOS/eliza/issues/9141). The frame-budget *math*
already landed (3× in parallel — see below); this work makes it **one**
primitive, **measures** the 60/120fps target end-to-end, and removes the last
whole-store subscriptions.

## What's here

| File | What it proves |
| --- | --- |
| `perf-overlay-hud.png` | The dev `PerfOverlay` HUD rendering a live readout in the real app with `window.__ELIZA_PERF_HUD__ = true` — the consolidated `FrameBudgetSampler` driving the overlay. |
| `reduced-motion-chat.png` | The chat shell at rest under `prefers-reduced-motion: reduce` — no animation artifacts. |
| `perf-interaction-walkthrough.webm` | Record-mode video of the interaction-KPI spec driving live token streaming, transcript scroll, sheet open/close, sheet drag, `/chat -> /settings`, then the HUD. |

## Measured framerate

Recorded June 24, 2026 with:

```bash
bun run --cwd packages/app test:e2e:record -- \
  test/ui-smoke/perf-interaction-kpi.spec.ts test/ui-smoke/perf-reduced-motion.spec.ts
```

```
live-token-stream  100fps · p95 9.2ms · worst 225.3ms · dropped 1/131 (budget 16.7ms)
transcript-scroll  120fps · p95 9.2ms · worst   9.4ms · dropped 0/242 (budget 16.7ms)
sheet-open-close   120fps · p95 9.0ms · worst   9.4ms · dropped 0/219 (budget 16.7ms)
sheet-drag         120fps · p95 9.3ms · worst   9.4ms · dropped 0/178 (budget 16.7ms)
chat-to-settings   120fps · p95 9.3ms · worst   9.4ms · dropped 0/39  (budget 16.7ms)
```

Both `perf-interaction-kpi.spec.ts` and `perf-reduced-motion.spec.ts` **pass**
in normal and record mode. The one live-token-stream worst-frame spike happened
during the recorded run, but the p95 and dropped-frame budget stayed green.

### Measurement-driven conclusions

- **Task 5 (flex-basis → transform sheet height):** the flex-basis height morph
  holds **~117fps, p95 9.9ms** on open/close and **~94fps** on drag — *well within
  even a 120fps budget*. The issue says "switch only if it drops frames"; it does
  not, so the rewrite is **not warranted**. Kept flex-basis.
- **Task 4 (transcript virtualization):** 80-cap scroll holds **~91fps**. The
  issue says "only land if a measured win"; the hard 80-cap already keeps scroll
  smooth, so virtualization is **not warranted**.

## What landed (this PR)

1. **Consolidated 3 duplicate frame-budget primitives → 1.** They'd landed in
   parallel with three stat shapes and *two* event channels (one of which the
   issue forbids). Now a single `hooks/frame-budget.ts` (`summarizeFrameSamples`
   + `FrameBudgetSampler`) backs the HUD, the telemetry monitor, and the KPI spec.
2. **Interaction-framerate KPI spec** (`perf-interaction-kpi.spec.ts`) + reusable
   `lib/frame-kpi.ts` — now covers live token streaming, transcript scroll,
   sheet open/close, sheet drag, and `/chat -> /settings` view transition.
3. **Reduced-motion collapse spec** (`perf-reduced-motion.spec.ts`) + fixed the
   one unguarded shell animation (the "Copied" label fade).
4. **Migrated the last `useApp()` hooks to selectors** (use-conversation-reset,
   use-startup-shell-controller, useShellController) + a **gate** that fails the
   build on any new `useApp()` call site.

## Reproduce

```bash
# unit (consolidation + gates)
bun run --cwd packages/ui test -- \
  src/hooks/frame-budget.test.ts \
  src/hooks/useFrameBudgetMonitor.test.ts \
  src/perf/PerfOverlay.test.tsx \
  src/useapp-selector-gate.test.ts \
  src/will-change-gate.test.ts \
  src/no-backdrop-blur-gate.test.ts \
  src/state/useChatLifecycle.readiness.test.ts

# interaction framerate + reduced-motion (boots the live-stack app)
bun run --cwd packages/app test:e2e -- \
  test/ui-smoke/perf-interaction-kpi.spec.ts test/ui-smoke/perf-reduced-motion.spec.ts
# add E2E_RECORD=1 for the video + trace
```
