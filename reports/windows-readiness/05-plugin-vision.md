# plugin-vision — Windows-Readiness Report

Path: `C:/Users/Administrator/Documents/eliza/plugins/plugin-vision`

## 1. Capability map

| Capability | Backing tech | Source |
|---|---|---|
| OCR — primary | RapidOCR / PP-OCRv5 ONNX via `onnxruntime-node`, models fetched from HuggingFace (`ilaylow/PP_OCRv5_mobile_onnx`) | `src/ocr-service-rapid.ts:35-43,158-177` |
| OCR — fallback | Tesseract.js v7 (WASM, English by default) | `src/ocr-service-real.ts:30-39` |
| OCR — Apple Vision | stub, throws on init (deferred to plugin-ios) | `src/ocr-service.ts:67-78` |
| Object detection — primary | YOLOv8n ONNX (Ultralytics HF mirror) via `onnxruntime-node` | `src/yolo-detector.ts:25-29,151-171` |
| Object detection — fallback | `@tensorflow-models/coco-ssd` over `@tensorflow/tfjs-node` (optional dep, lazy-loaded) | `src/vision-models.ts:9-29,89-99` |
| Pose detection | TF.js MoveNet MultiPose.Lightning | `src/vision-models.ts:103-118` |
| Face detection / recognition | `face-api.js` (ssdMobilenet+landmark+recognition+expression+ageGender) over node-`canvas` | `src/face-recognition.ts:1-99` |
| Face detection alt | MediaPipe BlazeFace ONNX (gated, not default) | `src/face-detector-mediapipe.ts:32-45` |
| Image captioning ("vision LLM") | "Florence2" branding masking an MobileNet v3 small ImageNet feature-vector model over TF.js (`tfhub.dev/.../mobilenet_v3_small_100_224`). Real Florence-2 / moondream / llava / VLM proper is **not** wired. Final fallback returns hard-coded scene strings | `src/florence2-local.ts:47-52,67-82,164-175` |
| Vision LLM gateway | `runtime.useModel(ModelType.IMAGE_DESCRIPTION)` — depends on runtime model provider (OpenAI/Anthropic/eliza-1). No Llama.cpp vision / transformers.js path locally. | `src/service.ts:1003-1019,1071-1078` |
| Screen capture | spawned `powershell` running `System.Windows.Forms`+`System.Drawing` `CopyFromScreen` (GDI) | `src/screen-capture.ts:190-203`, `src/workers/screen-capture-worker.ts:350-365` |
| Display enum | `wmic path Win32_DesktopMonitor` / `Win32_VideoController` | `src/screen-capture.ts:57-62`, `src/workers/screen-capture-worker.ts:144-167`, `src/tests/e2e/vision-worker-tests.ts:298-302` |
| Camera enum | `Get-PnpDevice -Class Camera` (PowerShell) | `src/service.ts:1817-1834` |
| Camera capture | `ffmpeg -f dshow -i video="..."` | `src/service.ts:1888-1906` |
| Audio capture | `ffmpeg -f dshow` (one-shot + streaming) | `src/audio-capture.ts:211-216`, `src/audio-capture-stream.ts:110-127` |
| Image pipeline | `sharp` (libvips); `@img/sharp-win32-x64@0.34.5` is installed and working (`node_modules/.bun/.../sharp-win32-x64.node` present) | global |
| node-canvas | Windows binary + 40+ MinGW DLLs present under `plugin-vision/node_modules/canvas/build/Release/` | resolved |

## 2. Windows blockers (real, observed on this host)

This Windows 11 build (10.0.26200) is missing two binaries every Windows code path depends on:

- `ffmpeg` — not on PATH. Camera capture, audio capture, audio streaming, audio device enumeration all hard-call `ffmpeg -f dshow ...`. `checkCameraTools` reports unavailable and the camera silently stays null (`src/service.ts:236-239,1888-1906`).
- `wmic` — Windows 11 24H2+ deprecates `wmic`; not present here. Every screen-info / display-enumeration call falls into the catch and silently uses the 1920×1080 fallback (`src/screen-capture.ts:56-69`, `src/workers/screen-capture-worker.ts:144-183`).

PowerShell-based screen capture itself should still work because `Add-Type` + `CopyFromScreen` only needs PowerShell + .NET (both present). Display geometry will be wrong on multi-monitor setups, and on a single 4K monitor it will be cropped to 1080p.

Other Windows-specific defects in source:

1. **`process.env.HOME ?? "/tmp"` model-cache root** — broken on Windows. Used by RapidOCR, YOLO, and MediaPipe to compute `<state>/models/...`. With `HOME` unset and `ELIZA_STATE_DIR` unset, paths become `/tmp/.milady/models/...` which lands at the root of the current drive. Refs: `src/ocr-service-rapid.ts:89-95`, `src/yolo-detector.ts:173-179`, `src/face-detector-mediapipe.ts:96-102`. Fix: prefer `os.homedir()` / `os.tmpdir()`.
2. **Temp screenshot files written into `process.cwd()`** with `temp_screen_*.png`, racy if multiple agents run from same dir. `src/screen-capture.ts:79`, `src/workers/screen-capture-worker.ts:259-262`, `src/service.ts:1851-1855`. Use `os.tmpdir()`.
3. **PowerShell command injection / quoting** — `powershell -Command "${script.replace(/\n/g, " ")}"` with the output path interpolated raw. `\` is escaped but `'` is not. Same script lives twice (`src/screen-capture.ts:191-203`, `src/workers/screen-capture-worker.ts:352-365`). Should use `-EncodedCommand` or `spawn` with arg array.
4. **`wmic` deprecation** — should be replaced with `Get-CimInstance Win32_DesktopMonitor` (PowerShell), which is present on this host.
5. **Tesseract WASM language data** — `Tesseract.createWorker("eng", 1, …)` triggers a network fetch of `tessdata` on first init. If the host is offline it hangs without a clear error. `src/ocr-service-real.ts:30-38`.
6. **Face-API model directory** — `path.join(__dirname, "..", "models", "face-api")` (`src/face-recognition.ts:67`) — no `models/` directory exists in the package; init will throw the first time `FACE_RECOGNITION` is exercised.
7. **`onnxruntime-node` is optional and not currently installed** (no `node_modules/onnxruntime-node` under the plugin). RapidOCR, YOLO, PersonDetector, MediaPipe BlazeFace all silently disable. The Tesseract fallback works but is what every README labels "last-resort."
8. **"Florence2" is not Florence-2** — it loads MobileNet and the caption generator is `scenes[index]` over a 5-string array (`src/florence2-local.ts:164-175`). Any test that asserts a meaningful caption from local Florence-2 will hit canned strings.
9. **Worker thread path resolution** — uses `__dirname` to join `workers/screen-capture-worker.js`. After Bun build this is fine, but if the dist path uses `.cjs`/`.mjs` differently the worker won't be found.

## 3. End-to-end flow status on Windows (this host)

| Flow | Status | Reason |
|---|---|---|
| Screen → OCR (Tesseract) → text | works in principle | PowerShell capture OK; Tesseract.js OK; first-run downloads tessdata |
| Screen → OCR (RapidOCR) → text | **disabled** | `onnxruntime-node` not installed; even when installed, model dir resolves to `/tmp/.milady/...` on Windows |
| Screen → VLM (local) → description | **degenerate** | "Florence-2" is MobileNet + canned strings; only useful via `runtime.useModel(IMAGE_DESCRIPTION)` to OpenAI etc. |
| Camera → frame → analysis | **broken** | `ffmpeg` not on PATH |
| Point-and-click (vision + computeruse overlap) | not in this plugin | `plugin-computeruse` separate; provider exports scene + entities only |
| Multi-monitor screen capture | partially broken | `wmic` absent → display list defaults to one 1920×1080; PowerShell capture indexes `AllScreens[N]` which works but bounds came from a fallback |

## 4. Tests in place

- `src/ocr-service.test.ts` — RapidOCR availability + Apple-Vision tier toggles. No Windows-specific assertions.
- `src/yolo-detector.test.ts` — availability boolean + init failure on bad URL. Uses `/tmp/...` paths.
- `src/lifecycle.test.ts`, `lifecycle.integration.test.ts` — pure unit, no I/O.
- `src/toggle-actions.test.ts`, `eliza1-bridge.test.ts`, `trajectory.test.ts` — pure unit.
- `src/tests/e2e/vision-worker-tests.ts` — exercises display detection, screen capture, multi-display, FPS. Has Windows branches (`wmic`, PowerShell), but uses `Microsoft.Photos.exe` and `taskkill` for cleanup which fails silently on newer Windows.
- `test/vision-cross-platform.e2e.test.ts` / `vision.real.e2e.test.ts` — fixture-PNG plumbing; skips if no model surface configured.

There is **no** end-to-end test that asserts on Windows: "open known PNG → call OCR → assert text equals X." That gap is the single highest-value addition.

## 5. Prioritized checklist

**P0 — required for any Windows OCR/vision to actually work**

1. Install `ffmpeg` on PATH **or** rewrite Windows camera/audio capture to use a PowerShell + Windows Media path (e.g. `MediaCapture` UWP API or `imagecap`).
2. Replace `wmic` calls with `Get-CimInstance Win32_DesktopMonitor` / `Win32_VideoController` — `wmic` is no longer shipped on Windows 11 26100+.
3. Fix `process.env.HOME ?? "/tmp"` in `ocr-service-rapid.ts:93`, `yolo-detector.ts:177`, `face-detector-mediapipe.ts:100` to use `os.homedir()` and `os.tmpdir()`. Otherwise every ONNX backend writes models to `/tmp/.milady/...` on the current drive root.
4. Install `onnxruntime-node` (currently absent under the plugin) and validate first-run model fetch + sha256-skipped load.

**P1 — correctness**

5. Provide a `tessdata` cache directory + offline-friendly `langPath` for Tesseract.js so first-run doesn't depend on remote fetch.
6. Move temp screenshot path from `process.cwd()` to `os.tmpdir()` (`screen-capture.ts:79`, `workers/screen-capture-worker.ts:260`, `service.ts:1853`).
7. Ship or auto-download `models/face-api/*` weights, or document the fetch step. Currently `face-recognition.ts:85-89` throws on first use.
8. Replace `powershell -Command "<inline>"` with `spawn("powershell", ["-NoProfile","-NonInteractive","-EncodedCommand", base64(script)])` to defuse quoting bugs.

**P2 — quality**

9. Add a Windows-only vitest (`vision-windows.e2e.test.ts`) that: takes a fixture PNG → runs `OCRService.extractText` (Tesseract chain) → asserts substring; and runs `ScreenCaptureService.captureScreen` → asserts PNG bytes returned.
10. Rename/replace `florence2-local` — either wire a real ONNX Florence-2 or stop calling it that. The current implementation is a deceptive smoke test.
11. Add a Windows DirectML execution-provider switch (`executionProviders: ["dml","cpu"]`) for YOLO/RapidOCR/MediaPipe, gated on env.
12. Replace `Microsoft.Photos.exe` cleanup in the worker e2e (`vision-worker-tests.ts:349-352`) with a more reliable terminator; Photos was replaced by the new Media Player in recent builds.

## Key files (absolute)

- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\screen-capture.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\workers\screen-capture-worker.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\ocr-service.ts` / `ocr-service-real.ts` / `ocr-service-rapid.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\yolo-detector.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\face-detector-mediapipe.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\face-recognition.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\florence2-local.ts` / `florence2-model.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\vision-models.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\service.ts` (camera + describeScene wiring)
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\audio-capture.ts` / `audio-capture-stream.ts`
- `C:\Users\Administrator\Documents\eliza\plugins\plugin-vision\src\tests\e2e\vision-worker-tests.ts`

Bottom line: the plugin will *partly* work on this Windows host today — Tesseract OCR on a captured screenshot is the only fully-native path that requires no external tools (and even that depends on online tessdata fetch). RapidOCR, YOLO, MediaPipe, MoveNet, and the camera/audio pipelines all need the P0 items resolved before any "vision actually works end-to-end" claim holds.
