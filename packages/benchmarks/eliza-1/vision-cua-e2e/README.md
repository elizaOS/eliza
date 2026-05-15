# `@elizaos/bench-eliza-1-vision-cua-e2e`

End-to-end harness that exercises the eliza-1 vision + plugin-computeruse
loop. The harness drives the *real flow* the agent uses to "look at the
screen and click something":

```
captureAllDisplays()                       (plugin-computeruse)
  -> tileScreenshot()                      (plugin-vision; Qwen3.5-VL tiler)
    -> useModel(IMAGE_DESCRIPTION, …)      (eliza-1 / Qwen3.5-VL)
    +  OcrWithCoordsService.describe()     (plugin-vision / docTR-style)
  -> ground "the close button on the focused window" (VLM bbox)
  -> reconstructAbsoluteCoords()           (plugin-vision tiler)
  -> performDesktopClick(x, y)             (plugin-computeruse)
  -> captureAllDisplays() (re-capture)
  -> verify state change
```

Stub mode (default) wires the VLM, OCR, and click driver to canned
implementations under `src/stubs/` so the harness can run on CI without paid
inference. Each stub file carries a top-of-file warning that flags it as
**HARNESS WIRING ONLY** — none of the canned outputs are real benchmark
signal.

## Layout

```
vision-cua-e2e/
  package.json
  README.md                                — this file
  vitest.config.ts                         — opts the e2e test back into discovery
  pipeline.e2e.test.ts                     — runs the pipeline against fixtures
  reports/                                 — generated trace JSON lands here
  scripts/
    generate-fixtures.mjs                  — synthesise PNGs (idempotent)
  src/
    pipeline.ts                            — orchestrator
    types.ts                               — shared narrow types
    fixtures.ts                            — fixture loader
    screen-tiler.ts                        — local mirror of plugin-vision tiler
    stubs/
      stub-vlm.ts                          — fake IMAGE_DESCRIPTION handler
      stub-ocr.ts                          — fake OcrWithCoordsService
      stub-driver.ts                       — fake performDesktopClick
  fixtures/
    single-1920x1080/display-1/{frame,frame-after}.png
    ultra-wide-5120x1440/display-1/{frame,frame-after}.png
    multi-display-composite/display-1/{frame,frame-after}.png
    multi-display-composite/display-2/{frame,frame-after}.png
```

## Running it

```bash
# Generate the synthetic PNG fixtures (idempotent — re-run any time):
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e fixtures:generate

# Run the harness in stub mode (no inference, no OS-level mouse click):
bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test
```

Each test run writes a trace JSON to `reports/`:

```json
{
  "run_id": "vision-cua-e2e-2026-05-14T…",
  "mode": "stub",
  "fixture_id": "ultra-wide-5120x1440",
  "started_at": "…",
  "finished_at": "…",
  "duration_ms": 24,
  "displays": [
    {
      "displayId": "1",
      "displayName": "ultra-wide-5120x1440",
      "bounds": [0, 0, 5120, 1440],
      "scaleFactor": 1,
      "primary": true,
      "tileCount": 5,
      "stages": [
        { "stage": "capture",          "ok": true,  "duration_ms": 0,  "output_summary": "frame=… B for display 1" },
        { "stage": "tile",             "ok": true,  "duration_ms": 7,  "output_summary": "5 tile(s) at maxEdge=1280" },
        { "stage": "describe",         "ok": true,  "duration_ms": 0,  "output_summary": "Ultra-wide desktop tiled across two horizontal halves; …" },
        { "stage": "ocr",              "ok": true,  "duration_ms": 0,  "output_summary": "1 block(s), 3 word(s)" },
        { "stage": "ground",           "ok": true,  "duration_ms": 0,  "output_summary": "tile=tile-0-4 local=(1156,24)" },
        { "stage": "click",            "ok": true,  "duration_ms": 0,  "output_summary": "click @ display=1 x=… y=…" },
        { "stage": "recapture",        "ok": true,  "duration_ms": 0,  "output_summary": "frame-after=… B" },
        { "stage": "verify_state_change","ok": true,"duration_ms": 0,  "output_summary": "state changed (byte-diff)" }
      ],
      "clickTarget": { "displayId": "1", "absoluteX": …, "absoluteY": … },
      "stateChangeDetected": true
    }
  ],
  "stages": [ … ],
  "success": true,
  "failures": []
}
```

## Swapping stub for real eliza-1

The harness ships in stub mode because (a) eliza-1 weights are a heavy
dependency, (b) the surrounding plugins are landing in parallel and the
harness must not block on their final form, and (c) we never want the test
suite to move the real OS mouse.

To wire the real loop:

1. **Build / install eliza-1.** Confirm that
   `@elizaos/plugin-local-inference` is registered on the runtime; that
   plugin owns the `IMAGE_DESCRIPTION` slot for the local Qwen3.5-VL bundle.
2. **Set the env flag.**
   ```bash
   export ELIZA_VISION_CUA_E2E_REAL=1
   ```
3. **Replace the stubs in `runRealPipeline()`** (currently a typed
   placeholder in `src/pipeline.ts`):
   - `StubVlm.describe(...)` → `runtime.useModel(ModelType.IMAGE_DESCRIPTION, { imageUrl, prompt })`
   - `StubVlm.ground(...)`  → grounding-style call against the same
     `IMAGE_DESCRIPTION` handler (or a registered grounding model when
     plugin-vision exposes one).
   - `StubOcrWithCoords` → `getOcrWithCoordsService()` from
     `@elizaos/plugin-vision`.
   - `StubDriver.click(...)` → `performDesktopClick(x, y)` from
     `@elizaos/plugin-computeruse`.
   - `loadFixture(...)` → `captureAllDisplays()` /
     `captureDisplay(displayId)` from `@elizaos/plugin-computeruse`.
4. **Run only against a controlled UI surface.** The real driver moves the
   mouse and dispatches clicks. Run only inside a sandboxed desktop
   (Xvfb + a known fixture window, OSWorld VM, or a dedicated test
   account) — not against your live desktop.
5. **Re-capture diff.** Stub mode uses byte-equal comparison. Real mode
   should swap to a perceptual diff over a region around the click target
   (plugin-computeruse already exposes `frameDhash` / `diffBlocks` from
   `scene/dhash.ts` — drop them in here).

When all four substitutions are wired, the harness becomes the parity gate
for the "vision + CUA at parity" claim: the same JSON trace shape is
emitted, the same stages are recorded, and the same assertions in
`pipeline.e2e.test.ts` apply. The only difference is the source of the
captured pixels and the destination of the click.

## What this does NOT cover

- Actual VLM accuracy. The stub returns canned outputs; comparing real
  eliza-1 outputs against a held-out grounding set is a separate bench
  (sibling under `packages/benchmarks/vision-language/`).
- Actual OCR accuracy. Same caveat: real `OcrWithCoordsService` quality is
  measured by the OCR-specific bench, not here.
- Multi-step plans. This harness is one capture → one click → one verify.
  Multi-step OSWorld-style runs live in `packages/benchmarks/OSWorld/`.

The harness is the **integration scaffold**: if it's green, the pipes
between capture, tiling, VLM, OCR, grounding, click, and verify are all
hooked up and produce a structured trace. If it's red, one of those pipes
is broken.
