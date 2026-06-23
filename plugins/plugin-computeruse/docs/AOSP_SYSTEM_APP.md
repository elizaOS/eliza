# AOSP system-app deployment (computer-use on the Eliza AOSP fork)

> Status: **design + contract**. The desktop CUA surface (capture, input, scene,
> Brain→Cascade→dispatch) is production; the AOSP path is partially built —
> `createAospInputActor()` returns `null` in consumer builds today
> (`src/actor/aosp-input-actor.ts`), and the privileged bridge below is the
> remaining work. This doc is the contract that wiring must satisfy. See
> [`ANDROID_CONSTRAINTS.md`](./ANDROID_CONSTRAINTS.md) for the honest scope on
> stock (non-system) Android, and `docs/android-aosp-validation.json` for the
> release evidence manifest this path is gated on.

## Why a system app

On stock Android an app cannot freely read the framebuffer of *other* apps or
inject input into them — those are `signature|privileged` permissions. The Eliza
AOSP fork ships the agent as a **platform-signed system app** (or a privileged
companion service), which unlocks the two capabilities a computer-use agent
needs:

| Capability | Stock Android | AOSP system app |
|---|---|---|
| Full-screen capture | `MediaProjection` (per-session user consent, own-app-biased) | `SurfaceControl.captureDisplay` / `READ_FRAME_BUFFER` (no prompt, any display) |
| Global input injection | none (only own UI / a11y gestures) | `InputManager.injectInputEvent` with `INJECT_EVENTS` |
| Element grounding | `AccessibilityService` tree (opt-in) | `AccessibilityService` tree + OCR, always available |

## Manifest / signing

```xml
<!-- Platform-signed; placed on the system image (priv-app). -->
<uses-permission android:name="android.permission.READ_FRAME_BUFFER" />
<uses-permission android:name="android.permission.INJECT_EVENTS" />
<uses-permission android:name="android.permission.ACCESS_SURFACE_FLINGER" />
<application android:sharedUserId="android.uid.system" ... />
```

- Sign with the platform key; install under `/system/priv-app` (or
  `/product/priv-app`) with a matching `privapp-permissions` allowlist entry for
  the two signature permissions.
- Non-system builds **must** degrade to the `MediaProjection` + `AccessibilityService`
  path (see ANDROID_CONSTRAINTS.md). The plugin feature-detects at runtime and
  never assumes the privileged path.

## Capture — `ScreenState` source

The AOSP capture feeds the same per-display frame contract the desktop scene
uses (`DisplayCapture { display, frame: PNG }`, see `src/platform/capture.ts`):

- **Privileged**: `SurfaceControl.captureDisplay(DisplayCaptureArgs)` →
  `HardwareBuffer` → PNG. No user prompt; supports secondary/virtual displays.
- **Fallback**: `MediaProjection` + `ImageReader` (one-time user consent), wired
  in `src/mobile/android-scene.ts` / `mobile-screen-capture.ts`.

Both paths populate the Android scene (`android-scene.ts`) with display bounds so
multi-display coordinate translation (`src/platform/coords.ts`) works unchanged.

## Input — `AospPrivilegedInputBridge`

`src/actor/aosp-input-actor.ts` is the seam. `createAospInputActor()` returns
`null` today; the privileged bridge must implement the `ComputerInterface` verbs
via `InputManager.injectInputEvent`:

| Verb | Implementation |
|---|---|
| `click` / `double_click` / `long_press` | `MotionEvent` ACTION_DOWN→UP (→DOWN→UP) at (x,y), `INJECT_INPUT_EVENT_MODE_ASYNC` |
| `drag` | ACTION_DOWN → interpolated ACTION_MOVE waypoints → ACTION_UP (mirror the desktop manual-drag in `nut-driver.ts`) |
| `scroll` | per-notch ACTION_SCROLL or MOVE deltas (mirror the desktop per-notch split) |
| `type` | `KeyEvent` stream or `InputConnection` commit |
| `key` / `key_combo` | `KeyEvent` with meta-state |

Coordinates are **logical display pixels** (same contract the empirical Windows
probe established for nutjs); the bridge applies the display's density only if
`injectInputEvent` is found to operate in physical pixels on the target ROM —
verify empirically before adding any scale, exactly as documented for the
desktop driver.

## Grounding — Brain-less, Actor-only (cheap by construction)

There is **no mobile Brain** (no full-frame VLM reasoning loop on device). AOSP
uses the **Actor-only** path: `OcrCoordinateGroundingActor` resolves a target by
matching `Scene.ocr` (OCR boxes) and `Scene.ax` (`AccessibilityNodeInfo`
clickables) — exactly the structured readout `GET_SCREEN` produces (#9105 M2).
This means AOSP gets computer-use **without a remote VLM**:

1. `android-scene.ts` builds `Scene` from MediaProjection/SurfaceControl capture
   + the `AccessibilityNodeInfo` tree + OCR.
2. OCR provider: register **PaddleOCR PP-OCRv5 mobile (Paddle-Lite)** as the
   AOSP `CoordOcrProvider` via `registerCoordOcrProvider` (the same seam
   plugin-vision uses on desktop, #9105 M1) — on-device, ARM-optimized, zero LLM
   tokens.
3. `Cascade` grounds via `resolveReference` (OCR/AX text-match) with the
   per-Scene grounding cache (#9105 M5); `dispatch` routes the concrete coords to
   the `AospPrivilegedInputBridge`.

## Remaining work (tracked in #9105 M6)

- [ ] Implement `AospPrivilegedInputBridge` and return it from
      `createAospInputActor()` when the privileged permissions are held.
- [ ] `SurfaceControl.captureDisplay` capture path + `MediaProjection` fallback
      feeding `android-scene.ts`.
- [ ] Register Paddle-Lite PP-OCRv5 as the AOSP `CoordOcrProvider`.
- [ ] Empirically verify `injectInputEvent` coordinate space (logical vs
      physical) on the target ROM before any density scaling.
- [ ] Complete `docs/android-aosp-validation.json` evidence (capture + a click
      landed via injection + an OCR-grounded tap) and gate the release on it.

## Security

All destructive actions still pass through `ComputerUseApprovalManager`
(`smart_approve` by default). A platform-signed agent with `INJECT_EVENTS` is a
high-privilege component — keep approval gating on, scope the priv-app allowlist
to exactly the two signature permissions, and never expose the injection bridge
over an unauthenticated IPC surface.
