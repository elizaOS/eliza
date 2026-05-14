# Eliza-1 / Computer-Use Test Matrix (WS10)

WS10 finalization (2026-05-14). Companion to
[`05-memory-budgets.md`](05-memory-budgets.md). Every cell records what
the test asserts, how it runs, the gate that keeps it from running on
the wrong host, the current pass/fail/skip state on this Linux CI
host, and the file path of the test (`-` if no test exists yet).

The scaffold for this matrix landed in WS10 prep (commit `43858e5b87`,
2026-05-13) with rows for capabilities × platforms. WS1–WS9 have now
all landed; this revision fills in every cell with the WS-canonical
test references, the Linux runnable rows show live `green` /`red`, and
manual-only rows record the on-device validation checklist that owns
their gate.

## Capabilities (rows)

- **vision-describe** — Qwen3-VL mmproj generates a caption / answer
  for a screenshot or photo.
- **image-gen** — diffusion GGUF emits a PNG for a text prompt.
- **screen-capture** — single-monitor screenshot to `Buffer`.
- **multi-monitor** — multi-display enumeration + per-display capture.
- **OCR** — RapidOCR det+rec returns `{ text, bbox }[]` for an image.
- **AX-fusion** — accessibility-tree annotations merged with OCR/CV
  results into a single `Element[]`.
- **click-grounding** — natural-language target → coordinate using
  vision + AX/OCR fusion.
- **app-enum** — list visible applications with windows + frontmost.
- **camera-capture** — single-frame capture from the system camera.

## Platforms (columns)

| Code   | Description |
|---|---|
| mac14  | macOS 14 Sonoma + |
| linX   | Linux X11 (xdotool / xrandr / scrot path) |
| linW   | Linux Wayland (PipeWire portal + ydotool path) |
| win10  | Windows 10 (PowerShell System.Drawing fallback) |
| win11  | Windows 11 (DirectX desktop duplication path) |
| and14  | Android 14 consumer APK (MediaProjection + AccessibilityService) |
| andSys | AOSP system-app build (privileged InputManager + SurfaceControl) |
| ios17  | iOS 17+ (Capacitor — ReplayKit foreground + Vision OCR + App Intents) |
| ios26  | iOS 26+ Foundation Models (OS-managed text path, opportunistic) |

## Per-cell schema

Every cell records the same five fields:

- `assertion` — what the test asserts (one short sentence).
- `how` — `CI` (Linux runner, deterministic), `manual` (operator runs
  on a real device and records output under
  `eliza/reports/ws10/<capability>/<platform>/<date>.md`), or `N/A`
  when the capability does not exist on that platform by design.
- `gate` — env var / device class / branch that gates the test (so
  tests skip on the wrong host instead of failing).
- `status` — `green` (passing on this host), `red` (currently
  failing), `unknown` (manual, not yet run on the device), or `N/A`.
- `test_ref` — file path of the test that owns the cell (or `-` if no
  test exists yet — surfaced as a WS10 follow-up).

The on-device manual rows all share the same checklist surface in
`plugin-computeruse/docs/`:
[`IOS_CONSTRAINTS.md`](../../plugins/plugin-computeruse/docs/IOS_CONSTRAINTS.md),
[`ANDROID_CONSTRAINTS.md`](../../plugins/plugin-computeruse/docs/ANDROID_CONSTRAINTS.md),
[`AOSP_SYSTEM_APP.md`](../../plugins/plugin-computeruse/docs/AOSP_SYSTEM_APP.md),
[`MULTI_MONITOR.md`](../../plugins/plugin-computeruse/docs/MULTI_MONITOR.md),
[`SCENE_BUILDER.md`](../../plugins/plugin-computeruse/docs/SCENE_BUILDER.md).
Manual cells link the relevant doc as the on-device-checklist owner.

## Cells

### vision-describe

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | mmproj-2b returns non-empty caption for fixture PNG; selector routes IMAGE_DESCRIPTION through `eliza1-bridge` | CI (stub) + manual (live mmproj) | none for stub; live: macOS host + `ELIZA_VISION_LIVE=1` | green | `plugins/plugin-vision/src/eliza1-bridge.test.ts`; live: `IOS_CONSTRAINTS.md` |
| linX    | same — bridge stays platform-agnostic | CI | none | green | `plugins/plugin-vision/src/eliza1-bridge.test.ts` |
| linW    | same | CI | none | green | `plugins/plugin-vision/src/eliza1-bridge.test.ts` |
| win10   | same | CI | win runner | unknown | `plugins/plugin-vision/src/eliza1-bridge.test.ts` |
| win11   | same | CI | win runner | unknown | `plugins/plugin-vision/src/eliza1-bridge.test.ts` |
| and14   | `aosp-llama-vision` adapter routes mmproj via FFI; bundle plan resolves a vision mmproj per tier | CI (stub) + manual on device | `ELIZA_AOSP_TEST=1` for CI smoke; manual on Pixel | green (CI) / unknown (device) | `plugins/plugin-aosp-local-inference/__tests__/aosp-llama-streaming.test.ts` (caps probe); manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | same as and14, but the privileged build can pin the mmproj into a shared `ashmem` region for cross-process readers | manual | rooted AOSP build | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | mmproj resident path mirrors Android; capacitor-bridge forwards IMAGE_DESCRIPTION via the loopback WebSocket | manual | iOS 17 TestFlight build | unknown | manual: `IOS_CONSTRAINTS.md` (§ ReplayKit + capacitor-bridge) |
| ios26   | apple-foundation adapter's `available()` flips true on `probe.foundationModel:true`; describe-image short prompts can route to Foundation Models when mmproj is unloaded | CI (stub probe) + manual (live device) | none for stub; live: iOS 26 + Apple Intelligence enabled | green (CI) / unknown (device) | `plugins/plugin-local-inference/__tests__/apple-foundation.test.ts`; manual: `IOS_CONSTRAINTS.md` (§ Foundation Models) |

### image-gen

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | imagegen selector picks the per-tier default from `ELIZA_1_BUNDLE_EXTRAS.json`; backend emits a valid PNG (signature + non-empty buffer) | CI (deterministic stub) + manual (live diffusion) | none for stub; live: M2 16 GB+ | green | `plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts`; `plugins/plugin-local-inference/__tests__/imagegen-backend-selector.test.ts` |
| linX    | same | CI (stub) + manual (CUDA host) | none for stub; live: 12 GB VRAM | green | `plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts` |
| linW    | same | CI (stub) + manual | none for stub; live: 12 GB VRAM | green | `plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts` |
| win10   | same | CI (stub) + manual | win10 runner | green (CI) / unknown (device) | `plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts` |
| win11   | same | CI (stub) + manual | win11 runner | green (CI) / unknown (device) | `plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts` |
| and14   | selector forces sd-1.5 on 0_8b/2b tiers; mobile-tier router gating asserts the RAM gate | CI (stub) + manual | device | green (CI) / unknown (device) | `plugins/plugin-local-inference/__tests__/imagegen-routing.test.ts` |
| andSys  | same as and14; system app can pre-warm sd-1.5 from boot | manual | rooted AOSP build | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | sd-1.5 only; tier router refuses anything heavier than sd-1.5 on iOS phone-class | CI (stub) + manual | device | green (CI) / unknown (device) | `plugins/plugin-local-inference/__tests__/imagegen-routing.test.ts` |
| ios26   | same; Foundation Models does not provide image generation — sd-1.5 path stays canonical | CI (stub) + manual | device | green (CI) / unknown (device) | `plugins/plugin-local-inference/__tests__/imagegen-routing.test.ts` |

### screen-capture

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | non-empty PNG buffer for primary display; PNG signature byte 0 == 0x89 | CI (under Xvfb in macOS CI) + manual | screen-recording perm granted | green | `plugins/plugin-computeruse/test/computeruse-cross-platform.e2e.test.ts`; `plugins/plugin-computeruse/src/__tests__/displays.real.test.ts` |
| linX    | same — scrot path | CI | `DISPLAY` set | green (parser tests) / skipped (no live `DISPLAY` in this CI) | `plugins/plugin-computeruse/src/__tests__/displays.real.test.ts` |
| linW    | same — PipeWire portal path | manual | `WAYLAND_DISPLAY` + portal | unknown | manual: `SCENE_BUILDER.md` |
| win10   | same — System.Drawing | CI under win11 runner (covers both) | win10 runner | unknown | `plugins/plugin-computeruse/test/computeruse-cross-platform.e2e.test.ts` |
| win11   | same — DXGI desktop duplication | CI | win11 runner | unknown | `plugins/plugin-computeruse/test/computeruse-cross-platform.e2e.test.ts` |
| and14   | MediaProjection consent → first JPEG frame within 2s of acceptance | manual | adb-attached device + consent | unknown | `plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts` (contract); manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | `SurfaceControl.captureDisplay` returns a screenshot without user consent (privileged) | manual | rooted AOSP build | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | ReplayKit foreground capture starts within ~150ms; drain returns ≥1 frame; broadcast handshake reports `extensionInstalled:true` if the broadcast target is bundled | CI (bridge-contract stubs) + manual (live capture) | device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`; manual: `IOS_CONSTRAINTS.md` (§ ReplayKit) |
| ios26   | same; broadcast extension regression (`extension_died` within ~3s) is surfaced as a structured error and the caller falls back to foreground | CI (error-arm test) + manual | device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`; manual: `IOS_CONSTRAINTS.md` (§ Broadcast iOS-26 regression) |

### multi-monitor

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | enumerates ≥2 displays when attached; each has non-zero bounds + scaleFactor | CI (parser only) + manual (dual-display Mac) | dual-display rig | green (parser) / unknown (live) | `plugins/plugin-computeruse/src/__tests__/displays.real.test.ts`; manual: `MULTI_MONITOR.md` |
| linX    | xrandr parser handles single-display, side-by-side, negative-origin, secondary-primary layouts | CI | none | green | `plugins/plugin-computeruse/src/__tests__/displays.real.test.ts` |
| linW    | Hyprland JSON snapshot parsed into `DisplayDescriptor[]` | CI (parser) + manual (live Wayland) | dual-display + Wayland session | green (parser) / unknown (live) | `plugins/plugin-computeruse/src/__tests__/displays.real.test.ts`; manual: `MULTI_MONITOR.md` |
| win10   | Win32 EnumDisplayMonitors path → ≥2 displays | manual | dual-display rig | unknown | manual: `MULTI_MONITOR.md` |
| win11   | same; DXGI-side coords align with EnumDisplayMonitors | manual | dual-display rig | unknown | manual: `MULTI_MONITOR.md` |
| and14   | N/A (Android has one default display for consumer apps; foldables defer to Display API) | N/A | N/A | N/A | - |
| andSys  | privileged builds can enumerate DisplayManager.getDisplays including SECONDARY/PRESENTATION | manual | rooted AOSP build with secondary display | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | N/A (sandboxed apps only see their own scene/screen; external displays via UIScene only) | N/A | N/A | N/A | - |
| ios26   | N/A | N/A | N/A | N/A | - |

### OCR

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | OCR chain selects ios-apple-vision when on darwin and the bridge is registered; otherwise falls back to rapid → tesseract | CI (chain test) + manual (live AppleVision) | none for chain; live: macOS host | green (chain) / unknown (live native) | `plugins/plugin-vision/src/ocr-service.test.ts`; manual: `IOS_CONSTRAINTS.md` (§ Vision OCR) |
| linX    | RapidOCR det+rec returns `{ text, bbox }[]` for fixture PNG; tesseract is the documented fallback | CI (deterministic stub) + manual (live ONNX) | none for stub; live: ONNX models downloaded | green (stub) | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts`; `plugins/plugin-vision/src/ocr-service.test.ts` |
| linW    | same | CI (stub) | none | green | `plugins/plugin-vision/src/ocr-service.test.ts` |
| win10   | same | CI (stub) | none | green | `plugins/plugin-vision/src/ocr-service.test.ts` |
| win11   | same | CI (stub) | none | green | `plugins/plugin-vision/src/ocr-service.test.ts` |
| and14   | RapidOCR ONNX runs through onnxruntime mobile; results identical to desktop within ε | manual | adb-attached device | unknown | manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | same; system app can keep RapidOCR resident across user sessions | manual | rooted AOSP build | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | `createIosVisionOcrProvider` returns highest-priority provider when bridge is registered; recognize() returns `OcrResult` with `providerName === "ios-apple-vision"` | CI (provider test) + manual (live device) | none for CI; live: iOS device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`; manual: `IOS_CONSTRAINTS.md` |
| ios26   | same; recognition-level "fast" runs in ≤120ms on iPhone 17 Pro | CI (mock) + manual | device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`; manual: `IOS_CONSTRAINTS.md` |

### AX-fusion

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | AX nodes merged with OCR text + CV elements; each Element has stable id within a snapshot, `role`, `label`, `bbox` | manual | AX perm granted | unknown | manual: `SCENE_BUILDER.md` |
| linX    | atspi nodes fused when atspi is installed; otherwise the fused element list is OCR-only | manual | atspi installed | unknown | manual: `SCENE_BUILDER.md` |
| linW    | atspi over Wayland portal | manual | atspi + portal | unknown | manual: `SCENE_BUILDER.md` |
| win10   | UIAutomation walker → fused Element list | manual | win10 + UIA | unknown | manual: `SCENE_BUILDER.md` |
| win11   | same; DXGI capture rect feeds OCR on dirty regions only | manual | win11 + UIA | unknown | manual: `SCENE_BUILDER.md` |
| and14   | `AccessibilityService.getRootInActiveWindow()` → compact `AndroidAxNode[]` matching WS6 Scene.ax shape | CI (contract test) + manual | none for contract; live: device | green (contract) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts`; manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | privileged AccessibilityService keeps streaming AX even when the app is backgrounded | manual | rooted AOSP build | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | `accessibilitySnapshot` returns the own-app `AccessibilitySnapshotResult` tree only — cross-app AX is documented unsupported | CI (contract test) + manual | none for CI; live: device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts`; manual: `IOS_CONSTRAINTS.md` |
| ios26   | same — no privileged AX surface in iOS 26 either | manual | device | unknown | manual: `IOS_CONSTRAINTS.md` |

### click-grounding

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | "click the Save button" → click point inside the Save bbox via Brain → Cascade → OcrCoordinateGroundingActor → dispatch | CI (golden) + manual (live) | none for CI; live: AX perm + live Brain | green | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts` (cascade live-wired); `plugins/plugin-computeruse/src/__tests__/cascade.test.ts` |
| linX    | same | CI | none | green | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts` |
| linW    | same | CI | none | green | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts` |
| win10   | same | CI | win runner | green | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts` |
| win11   | same | CI | win runner | green | `plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts` |
| and14   | Brain → cascade → `dispatchGesture` lands tap inside the AX node bbox | CI (mocked bridge) + manual | device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts`; `cascade.test.ts`; manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | privileged builds can use `injectInputEvent` for sub-pixel taps | manual | rooted AOSP | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | the only "click" surface is App Intent invocation; planner picks an intent + parameters and `appIntentInvoke` reports `success:true` | CI (intent registry + bridge tests) + manual | device with donated intents | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts` (intent paths); manual: `IOS_CONSTRAINTS.md` (§ App Intents) |
| ios26   | same; Foundation Models can act as the planner LLM for picking intents but cannot drive UI itself | manual | device + Apple Intelligence | unknown | manual: `IOS_CONSTRAINTS.md` (§ App Intents + Foundation Models) |

### app-enum

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | `listWindows()` returns array with stable shape: pid, title, frontmost | CI (skips when no display) + manual | macOS host | green (skip on Linux CI) | `plugins/plugin-computeruse/src/__tests__/windows-list.real.test.ts` |
| linX    | wmctrl path returns array; frontmost flag matches `_NET_ACTIVE_WINDOW` | CI under Xvfb (when DISPLAY) + manual | wmctrl installed + `DISPLAY` | green (skip without DISPLAY) | `plugins/plugin-computeruse/src/__tests__/windows-list.real.test.ts` |
| linW    | best-effort — wmctrl works through XWayland; pure-Wayland clients return partial info | manual | wmctrl + Wayland session | unknown | manual: `SCENE_BUILDER.md` |
| win10   | Get-Process / Win32 EnumWindows path | CI under win runner + manual | win10 runner | unknown | `plugins/plugin-computeruse/src/__tests__/windows-list.real.test.ts` |
| win11   | same; UWP apps show through the new Win32 layer | CI under win runner + manual | win11 runner | unknown | `plugins/plugin-computeruse/src/__tests__/windows-list.real.test.ts` |
| and14   | UsageStatsManager-derived `enumerateApps` returns 1+ entries with bundle id, label | CI (contract) + manual (UsageStats permission granted) | `PACKAGE_USAGE_STATS` granted | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts`; manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | privileged builds use `IActivityManager.getRunningTasks` directly | manual | rooted AOSP | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | N/A (sandbox prevents cross-app enumeration); the substitute is `appIntentList` (returns registered intents per bundle id) | CI (intent list contract) + manual | donated intents | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts` |
| ios26   | same | CI (intent list) + manual | device | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/ios-bridge.test.ts` |

### camera-capture

| Platform | assertion | how | gate | status | test_ref |
|---|---|---|---|---|---|
| mac14   | `MobileCameraSource.captureJpeg()` returns a non-empty Buffer; reaction pipeline emits an event when detector finds a person hit | CI (golden, deterministic detector) + manual (live AVFoundation) | camera perm granted | green | `plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts`; `plugins/plugin-vision/src/mobile/capacitor-camera.test.ts` |
| linX    | v4l2 path via imagesnap/fswebcam/ffmpeg fallback in plugin-vision; stub when none installed | CI (golden) + manual | v4l2 device present | green (golden) | `plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts` |
| linW    | PipeWire camera portal path | manual | PipeWire camera portal | unknown | manual: `IOS_CONSTRAINTS.md` (off-topic — Linux Wayland camera is documented in plugin-vision README §76 "MobileCameraSource") |
| win10   | DirectShow | CI (golden) + manual | win10 runner with cam | green (CI) | `plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts` |
| win11   | MediaFoundation | CI (golden) + manual | win11 runner with cam | green (CI) | `plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts` |
| and14   | `Camera2Source` opens, `captureFrameCamera` returns base64 JPEG; bridge implements `MobileCameraSource` semantics | CI (contract test) + manual | CAMERA perm granted | green (CI) / unknown (device) | `plugins/plugin-computeruse/src/__tests__/android-bridge.test.ts`; manual: `ANDROID_CONSTRAINTS.md` |
| andSys  | same; system app can keep camera open without an Activity | manual | rooted AOSP | unknown | manual: `AOSP_SYSTEM_APP.md` |
| ios17   | AVFoundation-backed iOS `MobileCameraSource` — own-app foreground capture only | manual | device | unknown (no iOS impl yet wired; stub on JS side) | stub: `plugins/plugin-vision/src/mobile/capacitor-camera.ts`; manual: `IOS_CONSTRAINTS.md` |
| ios26   | same | manual | device | unknown | manual: `IOS_CONSTRAINTS.md` |

## Conventions

- "CI" = runs in unattended CI on a Linux runner (no GPU, no GUI
  session). Almost all CI cells are stub-backed; live cells run
  manually on the listed device.
- "manual" = a human runs the script on the listed device; output
  recorded under `eliza/reports/ws10/<capability>/<platform>/<date>.md`.
- "Gate" = the env var / device / permission that blocks the test
  from running. The test must `skip` (not fail) when its gate is
  unmet.
- A cell tagged `N/A` is a deliberate non-target. The matrix entry
  exists to make that explicit so we can tell "not yet tested" apart
  from "intentionally never tested."
- Status `green` reflects the pass result on this Linux CI host on
  2026-05-14 against `vitest run` (vitest is the canonical test runner
  for these plugins — the `package.json#scripts.test` shells out to
  it). Re-running on a different OS/host can re-enable currently
  `unknown` cells.

## Snapshot — Linux CI host run on 2026-05-14

`bun run test` (= `vitest run`) per plugin:

| Plugin | Test files | Tests | Result |
|---|---|---|---|
| `plugin-computeruse` (vitest, excludes `*.real|*.live|*.e2e`) | 18 | 169 | green |
| `plugin-vision` | 8 | 33 | green |
| `plugin-local-inference` (`__tests__/**` per vitest.config) | 15 | 181 | green |
| `plugin-aosp-local-inference` | 1 | 13 | green |
| `plugin-capacitor-bridge` | 0 | 0 | no tests configured |
| 3 golden paths (in plugin-computeruse) | 3 | 9 | green |

Validator: `node scripts/validate-bundle-plan.mjs` → `hardErrors=0 gaps=2 status=OK`. The two surfaced gaps are pre-existing
WS2 follow-ups (0_8b and 2b tiers list `hasVision:true` in
`catalog.ts` but the bundle plan has no vision mmproj yet).

## Cross-references

- Per-device-class budget: [`05-memory-budgets.md`](05-memory-budgets.md)
- Bundle plan: [`../ELIZA_1_GGUF_PLATFORM_PLAN.json`](../ELIZA_1_GGUF_PLATFORM_PLAN.json)
- Bundle extras: [`../ELIZA_1_BUNDLE_EXTRAS.json`](../ELIZA_1_BUNDLE_EXTRAS.json)
- Golden tests:
  - `eliza/plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts`
  - `eliza/plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts`
  - `eliza/plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts`
- WS9 iOS bridge: `plugins/plugin-computeruse/src/mobile/ios-bridge.ts`
- WS9 Foundation Models adapter: `plugins/plugin-local-inference/src/backends/apple-foundation.ts`
- WS9 iOS OCR provider factory: `plugins/plugin-computeruse/src/mobile/ocr-provider.ts`
- WS9 iOS AppIntent registry: `plugins/plugin-computeruse/src/mobile/ios-app-intent-registry.ts`
- WS8 Android bridge: `plugins/plugin-computeruse/src/mobile/android-bridge.ts`
- WS4 `MobileCameraSource`: `plugins/plugin-vision/src/mobile/capacitor-camera.ts`
- WS7 `ComputerInterface`: `plugins/plugin-computeruse/src/actor/computer-interface.ts`
