# WebXR immersive panels — DOM→texture (origin-clean canvas) + OpenXR runtime setup

Evidence for the immersive WebXR panel renderer and the desktop OpenXR runtime
setup consolidated into `@elizaos/plugin-facewear`.

## `panel-content.png`
Two panels drawn by `rasterizePanelToCanvas` (`@elizaos/ui/spatial/panel-texture`)
— a header + accent rule + word-wrapped body on a dark rounded card (brand orange
accent only). This canvas is what `enterImmersiveScene` uploads as the WebGL panel
texture in a headset.

## Key finding (why a 2D canvas, not the panel's live DOM)
A WebGL texture must be origin-clean. An SVG `<foreignObject>` snapshot of real DOM
is **not** — Chromium/WebKit reject the upload (`texImage2D` → `SecurityError: …
may not be loaded`), both directly and via an intermediate canvas. Verified in the
IWER browser PoC: the foreignObject image decoded (`rasterOk: true`) but its WebGL
upload was refused. So content is drawn straight to a 2D canvas.

## IWER PoC (headless chromium + swiftshader, `immersive-vr`)
Read back from the session framebuffer at the panel centre:
- Green-canvas texture → `[0, 220, 0]` (texture path works, not the red fallback).
- `rasterizePanelToCanvas` content panel → reads the rendered card background
  `[18, 18, 24]` (real content reached the texture, not the fallback).

## Tests
- `packages/ui` spatial suite — 139/139 (incl. `panel-texture` word-wrap,
  `arrangeOnArc`, `webxr-runtime` availability).
- `plugin-facewear` OpenXR runtime detector — 9/9 (Linux active/stale/XDG/env,
  Windows registry, macOS-native, parse/identify) + 4/4 FacewearView component.
