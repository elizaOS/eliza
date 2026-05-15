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
    run-real.sh                            — real-mode launcher (preflight + cleanup trap)
  src/
    pipeline.ts                            — orchestrator (stub + real dispatch)
    types.ts                               — shared narrow types
    fixtures.ts                            — fixture loader
    screen-tiler.ts                        — local mirror of plugin-vision tiler
    real-runtime.ts                        — minimal IAgentRuntime + provider discovery
    real-vlm.ts                            — RealVlm over runtime.useModel(IMAGE_DESCRIPTION)
    real-ocr.ts                            — discovers RapidOcrCoordAdapter from plugin-vision
    real-driver.ts                         — RealDriver + spawnControlledWindow (xeyes)
    real-capture.ts                        — captureRealDisplays (plugin-computeruse)
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

## Real mode

Real mode wires the same pipeline against the live runtime stack:

| stage   | stub                            | real                                                                |
| ------- | ------------------------------- | ------------------------------------------------------------------- |
| capture | `loadFixture()` reads PNGs      | `captureAllDisplays()` (plugin-computeruse) — see `src/real-capture.ts` |
| tile    | local mirror of plugin-vision   | same                                                                |
| OCR     | `StubOcrWithCoords` canned text | `RapidOcrCoordAdapter` (plugin-vision) — see `src/real-ocr.ts`      |
| VLM     | `StubVlm` canned outputs        | `runtime.useModel(IMAGE_DESCRIPTION, …)` — see `src/real-vlm.ts`    |
| click   | `StubDriver` no-op recorder     | `RealDriver` over `performDesktopClick`, clamped into a controlled  |
|         |                                 | helper window — see `src/real-driver.ts`                            |

The minimal `IAgentRuntime` shim that hosts the IMAGE_DESCRIPTION handler
lives in `src/real-runtime.ts`. Provider discovery is in
`discoverRuntimeAdapter()`:

1. `ANTHROPIC_API_KEY` set → `@elizaos/plugin-anthropic` `handleImageDescription`.
2. `OPENAI_API_KEY` set → not yet wired (slot reserved).
3. Local eliza-1 bundle with a vision mmproj (`~/.eliza/local-inference/models/<bundle>/vision/*mmproj*.gguf`) → not yet wired (slot reserved; needs `@elizaos/plugin-local-inference` boot path).

If none of those provide a handler, `runRealPipeline()` throws
`NoVisionProviderError` and the trace is *not* written — the harness refuses
to fabricate output.

### Launching real mode

Use the launcher:

```bash
bash packages/benchmarks/eliza-1/vision-cua-e2e/scripts/run-real.sh
```

The launcher:

- Refuses to run on a headless host (`DISPLAY` / `WAYLAND_DISPLAY` must be set).
- Refuses to run without an IMAGE_DESCRIPTION provider (cloud key or local
  vision mmproj — exits 65 with a structured message).
- Spawns a controlled X11 window (`xeyes` by default; override with
  `ELIZA_VISION_CUA_E2E_CONTROLLED_WINDOW_BINARY`) into which all real
  clicks are clamped. The helper is killed in the EXIT trap.
- Runs `vitest run pipeline.e2e.test.ts` with `ELIZA_VISION_CUA_E2E_REAL=1`,
  which activates the real-mode `describe(...)` block in the test file.
- Writes the trace to `reports/eliza1-vision-cua-e2e-real-<timestamp>.json`.

Safety knobs (env on the launcher):

- `ELIZA_VISION_CUA_E2E_NO_CONTROLLED_WINDOW=1` — skip helper, force noop click.
- `ELIZA_VISION_CUA_E2E_NOOP_CLICK=1` — record clicks but never dispatch input.

### Real-mode prerequisites on this box

The harness's runtime expectations are concrete; verify each before
expecting a green run.

| requirement                           | how to check                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| Reachable desktop                     | `echo $DISPLAY` or `echo $WAYLAND_DISPLAY` non-empty                          |
| IMAGE_DESCRIPTION provider            | `$ANTHROPIC_API_KEY`, `$OPENAI_API_KEY`, OR `~/.eliza/local-inference/models/<bundle>/vision/*mmproj*.gguf` present on disk |
| Controlled helper binary              | `command -v xeyes` (or set `ELIZA_VISION_CUA_E2E_CONTROLLED_WINDOW_BINARY`)   |
| Linux input dispatch                  | `command -v xdotool` (only required if you want a real click; noop mode does not need it) |
| OCR-with-coords backend (plugin-vision) | optional — the OCR stage degrades to a structured failure in the trace if `RapidOcrCoordAdapter` cannot be constructed |

**Status as shipped (2026-05-15):** preflight currently blocks on the
provider check — the local eliza-1 bundles under
`~/.eliza/local-inference/models/eliza-1-{0_8b,2b}.bundle/` declare a
`vision/mmproj-*.gguf` in their manifest but the file is not staged on
disk, and no cloud key is exported. Once either is satisfied the launcher
runs end-to-end without further changes; the trace JSON shape matches the
stub-mode reports under `reports/`.

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
