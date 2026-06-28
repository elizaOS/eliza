# #9105 — On-device OCR / vision engine: best course of attack

_2026-06-28 — decision record for `feat/9105-tesseract-ship` + `feat/9105-image-description-fusion`._

OCR feeds **two** consumers in this repo:

1. **Image description** — `FusedVisionContextAugmenter` extracts OCR text (+ objects + faces) and fuses it into the VL prompt before on-device Gemma describes an image attachment (`plugins/plugin-vision/src/vision-context-augmenter.ts`).
2. **Screen vision for CUA** — `OcrWithCoordsService` returns word/block boxes with `semantic_position`, consumed by `plugin-computeruse`'s scene builder to ground click targets.

Both route through the **same per-platform OCR backend** via the `registerOcrWithCoordsService()` registry. So the engine choice below applies to both at once.

---

## TL;DR decision

**Use the OS-native vision engine on every platform that ships one. Keep Tesseract only where there is no platform engine (Linux / headless). docTR-GGML stays as the universal last-resort fallback only.**

| Platform | OCR engine | NPU/GPU | App-size cost | Status today | Action |
|---|---|---|---|---|---|
| **iOS** | Apple Vision `VNRecognizeTextRequest` (in-process Swift) | Neural Engine | 0 (in OS) | ❌ **falls to docTR (CPU)** — worst case | **BUILD native** |
| **macOS** | Apple Vision (`swift` CLI helper) | Neural Engine | 0 | ✅ on develop | keep |
| **Android** | **ML Kit Text Recognition v2** | GPU/NPU (TFLite) | ~260 KB unbundled / ~4 MB bundled | ❌ Tesseract4Android (CPU, +15 MB) | **REPLACE Tesseract → ML Kit** |
| **Windows** | `Windows.Media.Ocr` (WinRT) | native | 0 | ✅ on develop | keep |
| **Linux** | Tesseract CLI (portable bundle) | CPU only | bundled binary | ✅ on `tesseract-ship` | **keep — only valid Tesseract use** |
| Web / headless fallback | docTR (GGML) | CPU | model | ✅ on develop | keep as last resort only |

Same logic for **face / object detection**: prefer Apple Vision (`VNDetectFaceRectangles`, saliency/objectness) and ML Kit Face/Object Detection over the current all-CPU `face-detector-ggml` / `face-detector-mediapipe` / `yolo-detector` on mobile.

---

## Why — the efficiency case

The user's hunch is correct: **on iOS and Android the built-in engines are strictly better on battery, and free.** The platform OCR runs on the Neural Engine / GPU and is reused, shared OS code — it does not ship in our bundle and does not pin a CPU core.

- **Apple Vision** dispatches automatically to the Neural Engine (A12+), GPU fallback, CPU last. "Each operation runs in milliseconds on the Neural Engine, costs nothing per call, requires no network." On-device, private. ([Apple docs](https://developer.apple.com/documentation/vision/vnrecognizetextrequest), [createwithswift](https://www.createwithswift.com/recognizing-text-with-the-vision-framework/))
- **ML Kit Text Recognition v2** runs entirely on-device on TensorFlow Lite, "performance improves with GPUs or NPUs." Unbundled (Play Services) adds **~260 KB/script**; bundled **~4 MB/script**. No network, no cloud billing. Beats Tesseract on accuracy ("ML Kit outclassed Tesseract on many predictions"). ([ML Kit Text v2](https://developers.google.com/ml-kit/vision/text-recognition/v2/android), [fritz.ai comparison](https://fritz.ai/comparing-ml-kits-text-recognition-api-on-android-ios/))
- **Tesseract** is CPU-only, "lightweight and easily deployable… good for offline OCR on devices with limited resources," but "struggles with complex layouts, noisy/low-res images, scene text" — i.e. weakest exactly on phone screenshots / camera frames. On Android it is competitive on *speed for already-clean text* but worse on accuracy, and we ship **~15 MB** of `.so` + traineddata to get it. ([fritz.ai](https://fritz.ai/comparing-on-device-text-recognition-ocr/), [intuitionlabs](https://intuitionlabs.ai/articles/non-llm-ocr-technologies))

Net: shipping Tesseract4Android on a phone means **bigger app, more battery, lower accuracy** than the engine already sitting in the OS. Tesseract earns its keep on **Linux**, which has no first-party OCR — there it is the right call.

### Where Tesseract is genuinely the right tool
- **Linux desktop / server / headless CUA** — no OS OCR exists. The portable bundle (`vendor-tesseract-linux.mjs`) is correct and should stay.
- **Universal fallback** is already covered by docTR-GGML; we don't need Tesseract as a second fallback on mobile.

---

## The seam is already built for this swap

`feat/9105-tesseract-ship` designed the registry cleanly, so the migration is small:

```
agent (musl bun, no Capacitor)          renderer (Capacitor)            native
─────────────────────────────          ──────────────────────          ──────
OcrBridgeService.requestOcr(png)  --HTTP GET-->  poll()  -->  <plugin>.recognize(png)
   ^ returns OcrBridgeWord[]      <--HTTP POST--  submitResult()  <--  {words[],w,h}
   |
AndroidBridgeOcrService.describe() maps OcrBridgeWord[] -> OcrWithCoordsResult
```

- The **agent-side contract is engine-agnostic**: `OcrBridgeWord { text, left, top, width, height, confidence, block, par, line }`. ML Kit's `Text → TextBlock → Line → Element` hierarchy maps 1:1 onto `block / par(=block) / line` with `boundingBox` (Rect). `OcrWithCoordsResult` doesn't even carry confidence, so ML Kit not exposing per-element confidence is a non-issue (default 100 for the legacy `OCRResult` path).
- So **only two things change for Android**: (1) a new `plugin-native-mlkit-text` Capacitor plugin with the *same* `recognize()` definition as `plugin-native-tesseract`; (2) the renderer bridge calls ML Kit first, Tesseract only if ML Kit is unavailable. `AndroidBridgeOcrService` and all agent code are untouched.
- For **iOS**: add an in-process Apple Vision path (Swift in `plugin-native-*` or `ComputerUseBridge.swift`) + an `IosVisionOcrService implements OcrWithCoordsService`, and add the missing iOS branch to the dispatch in `plugin-vision/src/index.ts` so iOS stops falling to docTR. iOS cannot reuse the macOS `swift`-CLI helper (no subprocess / no runtime toolchain in the app sandbox) — it must be in-process.

`plugin-native-camera` is a complete Capacitor template (iOS `Sources/CameraPlugin/CameraPlugin.swift`, Android `CameraPlugin.kt`, `definitions.ts`, `web.ts`, `podspec`, `build.gradle`) to copy.

---

## Recommended dispatch (target state)

```ts
// plugins/plugin-vision/src/index.ts
if (isIosMobile() && _runtime) {
  registerOcrWithCoordsService(new IosVisionOcrService(_runtime));     // Apple Vision, in-process
} else if (isAndroidMobile() && _runtime) {
  registerOcrWithCoordsService(new AndroidBridgeOcrService(_runtime)); // ML Kit (Tesseract = renderer fallback)
} else if (macosVisionAvailable()) {
  registerOcrWithCoordsService(new MacosVisionCoordAdapter());         // Apple Vision swift CLI
} else if (WindowsMediaOcrService.isAvailable()) {
  registerOcrWithCoordsService(new WindowsMediaOcrService());          // WinRT
} else if (LinuxTesseractOcrService.isAvailable()) {
  registerOcrWithCoordsService(new LinuxTesseractOcrService());        // Tesseract (Linux only)
} else {
  registerOcrWithCoordsService(new RapidOcrCoordAdapter());            // docTR GGML — last resort
}
```

Renderer (`packages/ui/src/state/ocr-bridge.ts`): `getMlKitPlugin().recognize()` first, fall back to `getTesseractPlugin().recognize()` only if ML Kit reports unavailable — so a single bundle degrades gracefully on devices without Play Services.

---

## What changes on the two branches

**`feat/9105-tesseract-ship`** — keep the Linux Tesseract service, the registry seam, the renderer-pulled bridge architecture, Windows. **Demote Android Tesseract4Android to an optional fallback and drop its 15 MB of bundled binaries from the default app** in favour of ML Kit (unbundled via Play Services, ~260 KB). Add the iOS Apple Vision path + iOS dispatch branch.

**`feat/9105-image-description-fusion`** — `vision-context-augmenter.ts` is already on develop; this branch is mostly stale voice/kokoro churn. The only forward-looking piece is making the augmenter's `detectFaces` / `detectObjects` seam pluggable so mobile can register native (Apple Vision / ML Kit) detectors instead of the CPU GGML/YOLO ones. Same registry pattern as OCR.

---

## Verification reality

The OCR/face engines are **device-gated** — Kotlin/ML Kit needs a real Android build + device, Swift/Vision needs an iOS device/simulator. They cannot be exercised from this macOS dev host. TS-side glue (definitions, dispatch, bridge, services) is typecheck- + unit-test-verifiable here; native paths get on-device evidence captured on the Pixel / iPhone (consistent with how the rest of #9105 was validated).
