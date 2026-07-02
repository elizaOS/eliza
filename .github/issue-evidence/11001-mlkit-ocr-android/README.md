# #11001 — Android OCR via ML Kit Text Recognition v2 (bridge + native answerer)

On-device evidence for the ML Kit OCR bridge landing: the engine-agnostic OCR
bridge seam (salvaged per #9649 item 1 from `feat/9105-tesseract-ship`) plus the
new `@elizaos/capacitor-mlkit-text` native answerer, verified on a real device
and an emulator.

## What was verified

`MlKitTextReaderInstrumentedTest` (`connectedDebugAndroidTest`, the #9453
evidence pattern) drives the **real ML Kit Text Recognition v2 engine** through
`MlKitTextReader` — the exact class the shipped Capacitor plugin delegates to:

- `recognize_returnsRealTextAndBoxes` — renders `HELLO ELIZA 42` / `OCR BRIDGE`
  into a bitmap, runs recognition, asserts the real text comes back, every
  bounding box is positive and inside the bitmap, the two rendered lines land
  in distinct block/line groups (so the bridge's `mapOcrWordsToResult`
  grouping stays meaningful), and line 1 sits above line 2.
- `recognize_blankImageReturnsNoWords` — a blank bitmap yields zero words
  (no hallucinated text).

## Runs

| Target | Device | OS | Result |
|---|---|---|---|
| Real device | Pixel 6a (`27051JEGR10034`) | Android 16 | 2/2 passed — `connectedDebugAndroidTest-pixel6a-android16.xml` |
| Emulator | `eliza-viewtest` AVD (x86_64) | Android 14 | 2/2 passed — `connectedDebugAndroidTest-emulator-android14.xml` |

Command (from `packages/app-core/platforms/android`):

```bash
ANDROID_SERIAL=<serial> ./gradlew :elizaos-capacitor-mlkit-text:connectedDebugAndroidTest
```

## Bridge plumbing coverage (unit, vitest)

- `plugins/plugin-vision`: `ocr-bridge.test.ts`, `ocr-service-android-bridge.test.ts`,
  `routes.ocr.test.ts` — 13 tests (request queue/timeout/failure, word→coords
  mapping incl. tile offsets, route validation incl. malformed bodies).
- `packages/ui`: `src/state/ocr-bridge.test.ts` — 2 tests (renderer poller).
- `plugins/plugin-native-mlkit-text`: `src/web.test.ts` — web fallback rejects
  unsupported.

## Engine-dependency note

The plugin uses the **bundled** `com.google.mlkit:text-recognition:16.0.1`
artifact (model inside the app, no Play-Services model download, no network),
not the unbundled `play-services-mlkit-text-recognition` variant the issue
mentioned (~260 KB). Bundled keeps recognition deterministic on devices and
emulators without Google Play, at ~4 MB APK cost. No Tesseract4Android binaries
are anywhere in the tree (per the #9105 engine decision).
