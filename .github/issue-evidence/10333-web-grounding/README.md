# #10333 — web-element grounding benchmark (ScreenSpot-Web style)

The second "Needs CI infra" item from #9476's deferred checklist: a
**point-in-bbox web-element grounding** benchmark wired through the **real browser
screenshot + element-bbox path**, mirroring
`plugin-computeruse/src/parity/screenspot.ts` (which scores desktop grounding the
same way). Where the MiniWoB++ lane scores *action sequences*, this scores
*grounding*: given an instruction and a rendered page, a grounder predicts a
click point and the sample is correct iff the point lands inside the target
element's **true on-screen bounding box** (read from the real browser, never
hand-written).

## What this is

- `plugins/plugin-browser/src/benchmark/web-grounding.ts` — `pointInBox`,
  `scoreWebGrounding(engine, tasks, grounder)`, and a small ScreenSpot-Web-style
  task set (button / link / icon targets among same-shaped distractors). Samples
  are produced by rendering each page in a real Chromium (the same
  `ChromiumBenchmarkEngine` as the MiniWoB++ lane) and reading each target's bbox
  via puppeteer `boundingBox()`.
- `src/benchmark/__tests__/web-grounding-chromium.real.test.ts` — gated lane
  (run via `packages/test/vitest/real.config.ts`, self-skips with no browser).
  Asserts the **centre grounder** lands inside every target (accuracy 1) and the
  **corner grounder** misses every centred target (accuracy 0) — so the score
  reads real rendered geometry, not a hard-coded pass.

## Artifacts

- `scorecard.json` — **3/3 grounded** (accuracy 1), per-sample predicted point +
  true bbox + per-group breakdown.
- `01-ground-button.png` / `02-ground-link.png` / `03-ground-icon.png` — real
  Chromium screenshots with the target's **true bbox** outlined (orange) and the
  grounder's **predicted click point** drawn (cyan dot) landing inside it.

## Reproduce

```bash
bun run --cwd plugins/plugin-browser test:real:grounding       # gated assertion lane
bun run --cwd plugins/plugin-browser bench:grounding:chromium  # overlay screenshots + scorecard
```

Captured against the Playwright-installed Chromium headless-shell. As in the
computeruse harness, the large/licensed real ScreenSpot-Web dataset is not
vendored — these synthetic-but-**real-rendered** samples exercise the scorer +
the browser screenshot/bbox path end to end. Swapping in a learned grounder (a
VLM predicting points from the screenshot) is a drop-in for `centerGrounder`.
