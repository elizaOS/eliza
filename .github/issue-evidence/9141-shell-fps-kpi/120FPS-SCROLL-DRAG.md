# #9141 — pushing scroll + drag to 120fps

## Headline: on a real 120Hz display, scroll and drag are already at a clean 120fps

The previous KPI numbers (~60fps) were a **headless-Chromium artifact** — headless
rAF is software-clocked at a fixed ~60fps cadence, so the in-page sampler
physically cannot observe sub-16.7ms frames. Re-running the same spec **headed on
the ProMotion 120Hz Mac** tells the real story:

```
                    HEADLESS (artifact)        HEADED, warm (real 120Hz display)
transcript-scroll   ~96fps  p95 16.7ms    →   120fps · p95 9.2ms · worst 9.4ms · dropped 0/132
sheet-open-close    ~114fps p95  9.4ms    →   120fps · p95 9.1ms · worst 9.4ms · dropped 0/192
sheet-drag          ~92fps  p95 16.8ms    →   120fps · p95 9.2ms · worst 9.4ms · dropped 0/112
```

Scroll, sheet open/close, and sheet drag all sustain a **clean 120fps with zero
dropped frames**. The cold (first-run) pass showed two ~116–133ms one-off spikes
(JIT/first-paint/GC) that **did not reproduce** on the warm run, and a raw
per-frame dump of a fresh scroll was a flat `~8.3ms/frame, worst 9.4ms, zero
frames >12ms`.

So the stated goal — 120fps scroll + drag — is **already met on the target
high-refresh hardware**.

## What an exhaustive (6-dimension, adversarially-scoped) audit found

The transcript scroll is already an ideal **compositor scroll**: plain
`overflow-y-auto`, no `onScroll` handler, `React.memo`'d rows, rAF-coalesced
auto-scroll — **no per-frame JS or forced reflow**. The sheet drag drives a
framer-motion `MotionValue` (no per-frame `setState`). The remaining per-frame
costs are real but **GPU/compositor work the Mac's headroom absorbs** — they
matter for lower-end devices (phones via WebKit), battery, and the cold-start
hitch, not for the Mac's framerate:

1. **Pointer-event over-firing** (landed below): `pointermove` drove the drag
   fan-out / swipe `setState` *synchronously on every event* — and trackpads
   fire up to ~1000Hz, so the work ran many times per painted frame.
2. **Heavy `backdrop-filter`** (blur 16px + saturate 1.8 + brightness 0.68) on
   the sheet re-rasterizes as its `flex-basis` resizes each drag frame; a sticky
   `backdrop-blur` topic bar re-blurs each scroll frame.
3. **`setSwipeDx` React state** re-renders the overlay each horizontal-swipe frame.

## Landed: rAF-coalesce the pull gesture

`usePullGesture.onPointerMove` now coalesces the continuous drag/swipe updates to
**at most one per animation frame** (rAF-paced), instead of firing
`onDrag`/`onDragX` synchronously on every pointer event. A 1000Hz trackpad can no
longer run the `threadHeight` MotionValue fan-out (vertical sheet) or the
`setSwipeDx` overlay re-render (horizontal swipe) more than once per painted
frame — pure wasted CPU/battery removed, with no visual change (only the last
value of a frame is ever shown). Release/commit cancel the pending frame so a
stale value can't fight the settle.

Verified: 11 `use-pull-gesture` unit tests (incl. 2 new ones proving 3 pointer
moves → exactly one `onDrag` with the last value, and no stale apply after
release); headed perf run confirms drag still hits 120fps; chatux-gesture e2e
confirms the horizontal swipe still works.

## Deliberately NOT changed (measurement-driven)

- **`flex-basis` sheet height → `transform`**: the original issue's rule is
  "switch only if it drops frames." On the real 120Hz display the flex-basis
  morph holds a clean 120fps — it does **not** drop frames — so the risky rewrite
  (the whole scrim/header/radius morph is keyed off the flex height) is not
  warranted.
- **Dropping/reducing the sheet `backdrop-filter` during drag**: a GPU/battery
  win for lower-end devices, but toggling blur at gesture boundaries risks a
  visible flash — exactly the artifact this work avoids — and it's unmeasurable
  on the Mac (already 120fps). Left as a documented lower-end/battery candidate.
- **`setSwipeDx` → MotionValue** (fully removing the per-swipe-frame re-render):
  a further win for the *horizontal* swipe on lower-end devices; the rAF-coalesce
  already caps it at display rate. Deferred as a focused follow-up (moderate
  refactor of the swipe-hint indicators) rather than landing blind.

## Measurement note

A true 120fps gate needs a **headed run on a high-refresh display** — headless
CI cannot observe sub-16.7ms frames, so the default e2e KPI can only guard the
60fps floor. The shipped macOS renderer is also WKWebView (Electrobun) /
WebKit (Capacitor), so Chromium numbers approximate a different engine; an
OS-level `CADisplayLink` frame-presentation probe in the Electrobun shell is the
only ground-truth that the app presents at 120Hz. Reproduce the headed numbers:
`node scripts/run-ui-playwright.mjs --config playwright.ui-smoke.config.ts test/ui-smoke/perf-interaction-kpi.spec.ts --headed` (from `packages/app`, on a 120Hz display).
