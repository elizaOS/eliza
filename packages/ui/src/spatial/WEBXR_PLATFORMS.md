# WebXR — platform support, packaging, and what's validated

The PR #10064 `XRSpatialScene` renders the XR modality with **CSS transforms** — deterministic and headless-testable, but not a real headset session. `webxr-runtime.ts` is the seam that makes the XR modality *real* on every platform where WebXR is supported, with a graceful fallback where it isn't.

## The runtime (`@elizaos/ui/spatial`)

- **`ensureWebXR()`** — guarantees `navigator.xr` exists. Leaves a **native** implementation untouched; lazily installs `webxr-polyfill` (dynamic import — no bundle weight where native) only where the API is missing.
- **`detectWebXRCapability()`** — `{ present, native, polyfilled, immersiveVR, immersiveAR, inline }` for the *current* runtime.
- **`enterImmersiveScene({ canvas, panels })`** — requests an immersive session, binds an `XRWebGLLayer`, and renders the authored panels as world-placed quads via the session's own view/projection matrices (the `XRWebGLLayer` path the CSS renderer scopes out). Panel poses come from `xr-scene-math`. *Panel content is a solid tone quad today; DOM→texture compositing is the next step.*

## Support matrix (verified on this Linux host where noted)

| Surface / engine | `navigator.xr` native? | Path to working WebXR | Status |
|---|---|---|---|
| **Android APK** (Capacitor System WebView) | **No** — Chromium 148 WebView omits the WebXR Device API (verified on a Pixel 9a via CDP: `'xr' in navigator === false`, `WebGL2 = true`) | `ensureWebXR()` installs `webxr-polyfill` → `navigator.xr` + `immersive-vr` (Cardboard stereo) **verified true on-device** | ✅ via polyfill |
| **Desktop — Electrobun on Linux** (WebKitGTK) | **Yes** — WebKitGTK **2.52.3** ships WebXR, **default-on** (`WebXREnabled` is a stable feature; the `.so` exports the full `webkit_xr_permission_request_*` API + an OpenXR/DMA-BUF backend) | Needs (a) an **OpenXR runtime** on the machine (Monado / SteamVR — WebKit uses `XR_MNDX_egl_enable`), and (b) Electrobun to grant the WebKit `permission-request` for XR. `navigator.xr` is absent until a runtime is present. | ⚙️ engine-ready; needs OpenXR runtime + an Electrobun permission grant (upstream) |
| **Desktop — Electrobun on macOS** (WKWebView) | Partial — Safari/WKWebView WebXR is experimental on macOS; **immersive on visionOS** Safari | native where present; else polyfill inline | ⚙️ native where present |
| **Desktop — Electrobun on Windows** (WebView2 / Chromium) | Yes with a runtime | native + an OpenXR runtime (e.g. SteamVR) | ⚙️ native + runtime |
| **Web build in a headset browser** (Quest Browser, Wolvic) | **Yes** — real native immersive | `detectWebXRCapability()` → native → `enterImmersiveScene()` | ✅ native |
| **Web build in desktop Chrome/Edge + headset** | Yes with a runtime | native + OpenXR/SteamVR | ✅ native + runtime |

## Validated

- `webxr-runtime` availability contract — **vitest 4/4** (native-present, absent, per-mode support, throwing `isSessionSupported`).
- The **production** `enterImmersiveScene()` end-to-end against the IWER emulator (headless chromium, WebGL2): entered an `immersive-vr` session, ran the loop, drew **6 panels/frame** (3 panels × 2 eyes), correct stereo, `glError 0`.
- `webxr-polyfill` enabling `navigator.xr` + `immersive-vr` on a real Pixel 9a (CDP).
- WebKitGTK 2.52.3 WebXR build presence — `.so` symbols + 486-feature enumeration (`WebXREnabled` is stable/default-on).
- Full `packages/ui` spatial suite — **129/129**, no regression.

## Remaining to ship desktop-immersive

1. **OpenXR runtime** end-user dependency on Linux/Windows (Monado / SteamVR). Document in the desktop install.
2. **Electrobun WebKit `permission-request` grant** for `webkit_xr_permission_request` (an upstream Electrobun framework change — `upstreams/electrobun` is not checked out in this tree).
3. **DOM→texture panel content** in `enterImmersiveScene` (today: solid tone quads).
