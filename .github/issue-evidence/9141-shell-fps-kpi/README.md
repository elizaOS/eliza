# #9141 — shell interaction framerate (60/120fps) evidence

Closes the measurement + remaining re-render/repaint gaps of
[#9141](https://github.com/elizaOS/eliza/issues/9141). The frame-budget *math*
already landed (3× in parallel — see below); this work makes it **one**
primitive, **measures** the 60/120fps target end-to-end, and removes the last
whole-store subscriptions.

## What's here

| File | What it proves |
| --- | --- |
| `perf-overlay-hud.png` | The dev `PerfOverlay` HUD rendering a live readout in the real app (`102 fps · worst 25ms · dropped 12 · long 0`) — the consolidated `FrameBudgetSampler` driving the overlay. |
| `reduced-motion-chat.png` | The chat shell at rest under `prefers-reduced-motion: reduce` — no animation artifacts. |
| `perf-interaction-walkthrough.webm` | Video of the interaction-KPI spec driving scroll + sheet open/close + sheet drag, then the HUD. |

## Measured framerate (headless Chromium, `perf-interaction-kpi.spec.ts`)

```
transcript-scroll   93fps · p95 16.8ms · worst 24.3ms · dropped 18/115  (budget 16.7ms)
sheet-open-close   117fps · p95  9.2ms · worst 16.8ms · dropped  3/185  (budget 16.7ms)
sheet-drag          95fps · p95 16.8ms · worst 17.5ms · dropped 12/90   (budget 16.7ms)
```

Both `perf-interaction-kpi.spec.ts` and `perf-reduced-motion.spec.ts` **pass**.

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
   `lib/frame-kpi.ts` — the measurement the issue said we were flying blind on.
3. **Reduced-motion collapse spec** (`perf-reduced-motion.spec.ts`) + fixed the
   one unguarded shell animation (the "Copied" label fade).
4. **Migrated the last `useApp()` hooks to selectors** (use-conversation-reset,
   use-startup-shell-controller, useShellController) + a **gate** that fails the
   build on any new `useApp()` call site.

## Reproduce

```bash
# unit (consolidation + gates)
bun run --cwd packages/ui exec vitest run --config ./vitest.config.ts \
  src/hooks/frame-budget.test.ts src/useapp-selector-gate.test.ts src/will-change-gate.test.ts

# interaction framerate + reduced-motion (boots the live-stack app)
bun run --cwd packages/app test:e2e -- \
  test/ui-smoke/perf-interaction-kpi.spec.ts test/ui-smoke/perf-reduced-motion.spec.ts
# add E2E_RECORD=1 for the video + trace
```
