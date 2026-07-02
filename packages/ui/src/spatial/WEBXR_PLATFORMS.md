# WebXR — platform support, packaging, and what's validated

The PR #10064 `XRSpatialScene` renders the XR modality with **CSS transforms** — deterministic and headless-testable, but not a real headset session. `webxr-runtime.ts` is the seam that makes the XR modality *real* on every platform where WebXR is supported, with a graceful fallback where it isn't.

## The runtime (`@elizaos/ui/spatial`)

- **`ensureWebXR()`** — guarantees `navigator.xr` exists. Leaves a **native** implementation untouched; lazily installs `webxr-polyfill` (dynamic import — no bundle weight where native) only where the API is missing.
- **`detectWebXRCapability()`** — `{ present, native, polyfilled, immersiveVR, immersiveAR, inline }` for the *current* runtime.
- **`enterImmersiveScene({ canvas, panels })`** — requests an immersive session, binds an `XRWebGLLayer`, and renders the authored panels as world-placed **textured** quads via the session's own view/projection matrices (the `XRWebGLLayer` path the CSS renderer scopes out). Panel poses come from `xr-scene-math`. Panel *content* is real: it is drawn to an origin-clean 2D canvas (`panel-texture.ts`, `rasterizePanelToCanvas` — a header + word-wrapped body) and uploaded as a texture, with the panel's tone colour as the fill + graceful fallback if a source is origin-unclean.
- **`enterImmersiveFromSpecs(specs, opts)`** (`@elizaos/ui/spatial/immersive`) — author panels once (`{ id, title, lines, pose }` or a ready `texture`) → draw content textures → `ensureWebXR()` → enter, in one call. `handle.refreshTextures()` re-uploads updated content.

> **Why a 2D canvas, not the panel's live DOM.** A WebGL texture must come from an origin-clean source. An SVG `<foreignObject>` snapshot of real DOM is **not** origin-clean — Chromium (and WebKit) reject its upload: `texImage2D` throws `SecurityError: … may not be loaded`, both directly and via an intermediate canvas (a deliberate privacy measure against reading rendered HTML through the GPU). **Verified empirically** in the IWER PoC: a foreignObject rasterization decodes (`rasterOk: true`) but its WebGL upload is refused. So immersive content is drawn directly to a 2D canvas; rich interactive DOM stays on the CSS `XRSpatialScene` (flat-DOM) path.

## Desktop runtime setup → `@elizaos/plugin-facewear`

The desktop OpenXR runtime (the end-user dependency below) is detected + installed through **plugin-facewear**, the unified VR/AR/smartglasses surface:

- **`GET /api/facewear/xr-runtime`** → `{ status, plan }` (Monado/SteamVR/WMR detection + a ranked, platform-specific install plan).
- **`SETUP_XR_RUNTIME`** action — the agent's "is my VR/AR set up?" answer with exact install commands.
- **`bun run --cwd plugins/plugin-facewear setup:openxr`** — the installer CLI (no-root SteamVR where possible; Monado/WMR guidance otherwise).
- The **FacewearView** "vr/ar runtime" row surfaces status + a "Set up" button.

## Support matrix (verified on this Linux host where noted)

| Surface / engine | `navigator.xr` native? | Path to working WebXR | Status |
|---|---|---|---|
| **Android APK** (Capacitor System WebView) | **No** — Chromium 148 WebView omits the WebXR Device API (verified on a Pixel 9a via CDP: `'xr' in navigator === false`, `WebGL2 = true`) | `ensureWebXR()` installs `webxr-polyfill` → `navigator.xr` + `immersive-vr` (Cardboard stereo) **verified true on-device** | ✅ via polyfill |
| **Desktop — Electrobun on Linux** (WebKitGTK) | **Yes** — WebKitGTK **2.52.3** ships WebXR, **default-on** (`WebXREnabled` is a stable feature; the `.so` exports the full `webkit_xr_permission_request_*` API + an OpenXR/DMA-BUF backend) | (a) Electrobun grants the WebKit XR `permission-request` — ✅ **done in our fork** (`elizaOS/electrobun#1`, submodule bump #10095); (b) an **OpenXR runtime** on the machine (Monado / SteamVR — WebKit uses `XR_MNDX_egl_enable`) via **plugin-facewear** `setup:openxr`. `navigator.xr` resolves once a runtime is active. | ✅ engine-ready + grant merged; user installs a runtime |
| **Desktop — Electrobun on macOS** (WKWebView) | Partial — Safari/WKWebView WebXR is experimental on macOS; **immersive on visionOS** Safari | native where present; else polyfill inline | ⚙️ native where present |
| **Desktop — Electrobun on Windows** (WebView2 / Chromium) | Yes with a runtime | native + an OpenXR runtime (e.g. SteamVR) | ⚙️ native + runtime |
| **Web build in a headset browser** (Quest Browser, Wolvic) | **Yes** — real native immersive | `detectWebXRCapability()` → native → `enterImmersiveScene()` | ✅ native |
| **Web build in desktop Chrome/Edge + headset** | Yes with a runtime | native + OpenXR/SteamVR | ✅ native + runtime |

## Validated

- `webxr-runtime` availability contract — **vitest** (native-present, absent, per-mode support, throwing `isSessionSupported`).
- `panel-texture` word-wrap; `arrangeOnArc` arc symmetry.
- The **production** `enterImmersiveScene()` end-to-end against the IWER emulator (headless chromium, real WebGL2) — **committed, re-runnable**: `bun run --cwd packages/ui test:immersive-e2e` (`src/spatial/__e2e__/run-immersive-e2e.mjs` + `immersive-fixture.ts`). It enters an `immersive-vr` session on an emulated Quest 3 (stereo), runs the loop, and **reads the session framebuffer back with `gl.readPixels()` at math-predicted per-eye pixels**: a green canvas quad (texture path, not the red fallback), a `rasterizePanelToCanvas` content panel proven by TWO texture-space landmarks (card background + the drawn title accent rule — impossible for a 1×1 fallback texel), ipd parallax between the eyes, the `SecurityError` → `solidColorTexel` tone fallback for an origin-unclean source (cross-origin image without CORS; note: an SVG `foreignObject` snapshot **no longer taints** in current Chromium, though it still does in WebKit — the 2D-canvas content path remains the only portable choice), `refreshTextures()` re-upload, and teardown (frame counter frozen after `end()`, session released).
- `webxr-polyfill` enabling `navigator.xr` + `immersive-vr` on a real Pixel 9a (CDP).
- WebKitGTK 2.52.3 WebXR build presence — `.so` symbols + feature enumeration (`WebXREnabled` is stable/default-on).
- OpenXR runtime detector — **9/9** (`plugin-facewear`): Linux active/stale/XDG/env, Windows registry, macOS-native, parse/identify.
- Full `packages/ui` spatial suite, no regression.

## NOT yet validated (#10722 — do not claim otherwise)

- **The immersive render path (`enterImmersiveScene` / `enterImmersiveFromSpecs`)
  is not covered end-to-end.** The only committed test exercises the mocked
  `navigator.xr` availability contract; there is **no** IWER-emulator run that
  opens an `immersive-vr` session and reads back the session framebuffer, and no
  `setHandPose`/gaze interaction test. `enterImmersiveScene` also has **no
  production caller** today. Before advertising immersive as shipped, either add
  the framebuffer-readback + hand-pose e2e (IWER, headless chromium, WebGL2) or
  wire/remove the unused entry points.

## Remaining to ship desktop-immersive — all three done ✅

1. **OpenXR runtime** end-user dependency on Linux/Windows — ✅ detected + installed via **plugin-facewear** (`SETUP_XR_RUNTIME`, `GET /api/facewear/xr-runtime`, `setup:openxr`, FacewearView "vr/ar runtime" row). The user still installs Monado/SteamVR once; the plugin guides + automates the no-root path.
2. **Electrobun WebKit `permission-request` grant** — ✅ merged in our fork (`elizaOS/electrobun#1`); lands here via the `upstreams/electrobun` submodule bump (#10095).
3. **DOM→texture panel content** — code exists (`enterImmersiveScene` textures each panel from its rasterized DOM; `enterImmersiveFromSpecs` is the one-call author→immersive bridge) but is **not yet validated end-to-end and has no production caller** — see "NOT yet validated" above (#10722).
