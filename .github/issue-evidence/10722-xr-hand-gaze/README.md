# #10722 — XR hand-tracking + gaze input e2e

Real, headless (IWER-backed, no headset) e2e coverage for the XR simulator's
hand-tracking and gaze paths. Run:

```bash
bun run --cwd plugins/plugin-xr/simulator test:e2e
# 15 passed
```

## What is covered (drives the REAL input pipeline, asserts SEMANTIC outcomes)

### Hand tracking — `e2e/hand-input.spec.ts`
Drives IWER's `XRHandInput` (`oculus-hand` profile) via `emulator.setHandPose()`:

- **flat pinch aim + select** — a pinch-posed hand becomes the primary input
  modality, its target ray gets a real unit world direction, the computed hit
  resolves to the aimed element, and a pinch fires exactly one real session
  `select` from the HAND input source (`viaHand: true`).
- **left+right independent** — each hand aims and selects on its own target.
- **3D scene pinch-select** — the hand's WORLD ray hits the settings view's real
  `Save` button (world-space plane intersection, `panelId: settings`) and a
  pinch fires the authored view's real press handler **exactly once** — the same
  DOM handler the controller path fires. One session `select` recorded.
- **3D scene pinch-grab drag** *(this PR)* — a pinch-grabbed hand drags the
  settings panel `+0.6 m` along world +X through the real scene bridge
  (`hand ray → hitTest → dragPanel`, the same seam `dragController` uses). The
  panel's world pose actually changes, the un-grabbed wallet panel stays put,
  and the authored scene dispatches a real `move` SpatialAction with the new x.

### Gaze — `e2e/gaze-input.spec.ts`
- **flat + 3D head-gaze aiming** — the emulated headset's forward ray is a real
  gaze ray; aiming the head at named elements resolves the computed headset hit
  to each element, including world-space plane intersection in the 3D scene.
- **executable blocker pin** — IWER 2.2.1 CANNOT surface a live
  `targetRayMode: "gaze"` (or `"transient-pointer"`) XRInputSource: both exist
  only as enum values; the sole live sources (`XRController`, `XRHandInput`) are
  hard-coded to `tracked-pointer`, and `XRDevice.primaryInputMode` only toggles
  controller↔hand. `ActionPlayer` can replay a recording tagged `gaze` but that
  bypasses the live input pipeline (no gamepad transitions → no `select`), so it
  is not interactive gaze. The spec pins this with an assertion: if an IWER
  upgrade ever surfaces a gaze/transient-pointer source, the pin fails and the
  spec must be upgraded to drive a real gaze `select`. **No doc in this repo
  claims interactive gaze selection is tested** — only head-gaze *aiming* is.

## Artifacts

| file | what it shows |
|------|---------------|
| `xr-hand.png` | settings view mounted as a real 3D panel, hand-ray reticle on Save |
| `xr-hand.frames.json` | per-frame pose/ray/hit — hand-right `pinch`, ray unit dir, hit `elementId: save`, `panelId: settings`, world point |
| `xr-gaze.png` / `.frames.json` | 3D head-gaze aim, headset hit resolves to authored view elements |
| `xr-scene.png` / `.frames.json` | controller-path 3D scene reference |
| `xr-harness.png` / `.frames.json` | flat harness reference |

Regenerate into this dir:

```bash
XR_E2E_ARTIFACT_DIR=$(git rev-parse --show-toplevel)/.github/issue-evidence/10722-xr-hand-gaze \
  bun run --cwd plugins/plugin-xr/simulator test:e2e
```
