# #9968 — Real 3D XR spatial renderer + deterministic IWER harness

The deferred "depends on a real spatial renderer" half of #9968. The flat 2D
"XR" modality now has a genuine 3D spatial renderer (`XRSpatialScene`,
`packages/ui/src/spatial/xr-scene.tsx`) and the IWER harness drives the full
pose → ray → **computed 3D hit** → press → drag loop over real authored views,
headless and byte-stable.

## Artifacts

- `9968-xr-scene.png` — the 3D scene: gallery views placed as depth-ordered,
  perspective-arranged panels (profile / settings / wallet / confirm / progress)
  around a headset camera, rendered from one authored React tree.
- `9968-xr-scene-hit-loop.webm` — the "controller world ray computes the 3D hit
  on each gallery view" test: a controller ray is aimed at a named element in
  each view; the nearest panel-plane intersection resolves to that DOM element
  and the press fires the authored handler.
- `9968-xr-scene.frames.json` — per-frame pose/hit JSON. Every snapshot is
  `mode: "scene"` with the real headset/controller world poses, aiming rays, and
  the computed hit (e.g. `elementId: "save"`, `world: {…}`, `panelId: "settings"`).

## How to reproduce (no headset, headless Chromium)

```bash
# 3D scene loop + flat harness (4 + 4 specs), with capture:
bun run --cwd plugins/plugin-xr/simulator test:e2e:record
#   → e2e-artifacts/xr-scene.png + xr-scene.frames.json, videos in test-results/

# Real view-host route + real IWER emulator (9 specs, no mock, no skip):
bun run --cwd plugins/plugin-facewear/app-xr test:e2e

# Every registered view places + renders in the 3D scene (jsdom):
bun run --cwd packages/ui vitest run \
  src/spatial/__tests__/registered-view-parity.test.tsx \
  src/spatial/__tests__/xr-scene-math.test.ts
```

## Acceptance criteria → evidence

| Criterion | Where |
|---|---|
| Headless session: head + both controller poses, ray at a named element, read world position + ray + computed hit, assert hit == element, select/squeeze press, capture screenshot + per-frame JSON | `simulator/e2e/scene.spec.ts` + `harness.spec.ts`; artifacts above |
| Loop runs over **every** registered view; byte-stable | per-gallery-view in `scene.spec.ts`; full catalog in `registered-view-parity.test.tsx` |
| `camera-pose.spec.ts` runs and asserts (no `test.skip`); `view-server.mjs` deleted; view e2e exercises the **real** `view-host` route | `plugin-facewear/app-xr/e2e/{camera-pose,all-views-crud,voice-forms}.spec.ts` + `route-server.ts` |
| Exactly **one** XR emulator/harness implementation | `plugin-facewear/emulator/src/*` now re-export `@elizaos/plugin-xr` simulator (#9941) |
| `registered-view-parity.test.tsx` xr branch asserts XR-specific behaviour (3D scene placement), not a duplicate DOM mount | that test's XR branch |
| `plugin-xr/CLAUDE.md` states the real XR status | WEBXR_STATUS section |
| `SpatialAction` carries a drag/move variant; 3D drag e2e asserts panel relocation | `spatial/context.ts` (`move`) + the drag test in `scene.spec.ts` |

## Scope note (honest)

`XRSpatialScene` is **simulator-grade**: it composites panels with CSS transforms
so the loop is deterministic and headless-testable. Compositing the same panels
into a headset's **WebGL** layer on-device (immersive `XRWebGLLayer` render loop)
remains the native renderer's job; the math core supports arbitrarily-oriented
planes for that path. See `plugins/plugin-xr/CLAUDE.md` → WEBXR_STATUS.

**Real-LLM trajectory / audio:** N/A — test-infra + rendering change; no
agent/model/prompt or voice behaviour changed.
