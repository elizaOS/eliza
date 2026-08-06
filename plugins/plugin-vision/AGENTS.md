# @elizaos/plugin-vision

Camera, screen, OCR, object-detection, face-recognition, and scene-context services for Eliza agents.

## Role

The plugin turns camera or screen frames into runtime context and structured vision operations. Scene descriptions use the runtime's `ModelType.IMAGE_DESCRIPTION` handler; this package does not register or bundle a VLM. Native detectors and OCR engines enrich that model output, while entity tracking maintains identity across frames.

The package is Node-only and opt-in. It auto-enables when `config.features.vision` is enabled or `config.media.vision.provider` names a provider. Mobile camera, capture, and OCR work crosses the platform bridge contracts rather than importing native implementations here.

## Runtime surface

| Kind | Surface | Responsibility |
|---|---|---|
| Service | `VisionService` / `VISION` | Camera and screen lifecycle, frame analysis, VLM descriptions, OCR, detections, tracking, and memory-pressure coordination |
| Service | `ScreenCaptureBridgeService` | Queues renderer-performed screen captures and settles native bridge responses |
| Service | `OcrBridgeService` | Queues renderer-performed OCR and settles native bridge responses |
| Action | `VISION` plus promoted subactions | `describe`, `capture`, `get_screen`, mode and source controls, naming, identification, and tracking |
| Provider | `VISION_PERCEPTION` | Current scene, people, objects, tracked entities, and screen text |
| Routes | `/api/vision/*` | Raw-path renderer polling and result submission for capture and OCR |

Structured action parameters are authoritative. `src/action-params.ts` normalizes the operation and mode and deliberately does not infer them from arbitrary message substrings.

## Processing boundaries

- VLM descriptions always call `runtime.useModel(ModelType.IMAGE_DESCRIPTION, ...)`.
- YOLO uses the native ggml binding in `native/yolo.cpp` through `src/native/yolo-ffi.ts`; missing libraries or weights make initialization fail explicitly.
- Face detection and recognition use the ggml bindings in `face-detector-ggml.ts` and `face-recognition-ggml.ts`. `face-detector-mediapipe.ts` is only a deprecated compatibility shim and throws on initialization.
- The primary OCR chain is Apple Vision when a provider is registered on Apple platforms, then native DocTR. Renderer/mobile bridges and explicitly selected host adapters add Android, Windows, Linux Tesseract, or PaddleOCR paths.
- Set-of-Marks and coordinate OCR are bridged into `@elizaos/plugin-computeruse` through optional runtime seams. Vision remains usable without that plugin.
- `VisionServiceLifecycleManager` connects expensive sub-services to the shared memory arbiter when available and also enforces a local memory budget.

## Package map

```
src/
  index.ts                         plugin composition and optional bridge wiring
  action.ts / action-params.ts     VISION operations and structured parameters
  provider.ts                      VISION_PERCEPTION context
  service.ts                       main vision lifecycle and analysis loop
  config.ts / types.ts             validated settings and shared contracts
  routes.ts                        renderer capture/OCR bridge routes
  screen-capture.ts                host screen capture
  screen-capture-bridge.ts         renderer capture request queue
  screen-tiler.ts                  dirty-tile and priority processing
  dirty-tile-*.ts                  incremental screen-description state
  ocr-service.ts                   Apple Vision -> DocTR OCR chain
  ocr-service-*.ts                 platform and optional OCR adapters
  ocr-with-coords.ts               coordinate OCR registry
  ocr-bridge.ts                    renderer OCR request queue
  yolo-detector.ts                 native YOLO detector and NMS
  person-detector.ts               person-only detector projection
  face-detector-ggml.ts            native face detection
  face-recognition-ggml.ts         native face embeddings and matching
  entity-tracker.ts                cross-frame entity identity
  get-screen*.ts                   screen and element extraction
  som.ts / set-of-marks-provider.ts UI grounding overlays
  lifecycle.ts                     memory and idle lifecycle
  vision-context-augmenter.ts      OCR/object/face fusion for local inference
  computeruse-ocr-bridge.ts        optional computer-use integration
  mobile/                          mobile camera bridge contracts
  native/                          FFI loaders for DocTR and YOLO
  workers/                         OCR and screen-capture workers
native/
  doctr.cpp/                       native OCR implementation
  yolo.cpp/                        native object detector
auto-enable.ts                     dependency-light enablement check
```

## Commands

```bash
bun run --cwd plugins/plugin-vision build
bun run --cwd plugins/plugin-vision build:native
bun run --cwd plugins/plugin-vision build:weights
bun run --cwd plugins/plugin-vision typecheck
bun run --cwd plugins/plugin-vision lint:check
bun run --cwd plugins/plugin-vision format:check
bun run --cwd plugins/plugin-vision test
bun run --cwd plugins/plugin-vision dev
```

## Configuration

`ConfigurationManager` reads both `VISION_<KEY>` and bare `<KEY>` forms.

| Key | Default | Purpose |
|---|---:|---|
| `CAMERA_NAME` | auto | Partial camera-name match |
| `VISION_MODE` | `CAMERA` | `OFF`, `CAMERA`, `SCREEN`, or `BOTH` |
| `PIXEL_CHANGE_THRESHOLD` | `50` | Frame-change threshold |
| `ENABLE_OBJECT_DETECTION` | `false` | Enable native YOLO |
| `OBJECT_CONFIDENCE_THRESHOLD` | `0.5` | Object score threshold |
| `ENABLE_POSE_DETECTION` | `false` | Enable pose processing |
| `ENABLE_FACE_RECOGNITION` | `false` | Enable face matching |
| `VLM_UPDATE_INTERVAL` | `10000` | Milliseconds between scene descriptions |
| `SCREEN_CAPTURE_INTERVAL` | `2000` | Milliseconds between screen captures |
| `TILE_SIZE` | `256` | Screen tile edge length |
| `MAX_CONCURRENT_TILES` | `3` | Concurrent tile processing |
| `OCR_ENABLED` | `true` | Enable OCR |
| `OCR_LANGUAGE` | `eng` | Language hint for supporting backends |
| `FACE_MATCH_THRESHOLD` | `0.6` | Face-embedding match distance |
| `MAX_TRACKED_ENTITIES` | `100` | Entity tracker capacity |
| `MAX_MEMORY_USAGE_MB` | `2000` | Local lifecycle memory cap |

Additional thresholds and debug settings are defined in `VisionConfigSchema`. The optional PaddleOCR path is selected with `ELIZA_VISION_OCR_BACKEND=paddleocr`.

Host camera capture expects `imagesnap` on macOS, `fswebcam` on Linux, or `ffmpeg` on Windows. Their absence does not break module import, but camera startup cannot succeed.

## Extension rules

- Add VISION operations to `VISION_OPS`, implement their handlers in `action.ts`, and require structured parameters.
- Register new services, providers, or raw routes in `src/index.ts`; exported code is not automatically active.
- Keep model execution behind runtime model handlers and native model residency behind the lifecycle/memory-arbiter boundary.
- Keep optional integrations dependency-light and dynamically wired. Do not make computer-use or a platform bridge a hard runtime dependency.
- Treat missing models, libraries, malformed images, and bridge failures as errors or explicit unavailable states. Never fabricate detections, OCR, or scene descriptions.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run the relevant build, typecheck, lint, and test lanes, then exercise the real camera, screen, OCR, detector, or mobile bridge changed. Review actual frames, recognized text, detections, logs, and failure states. A mocked detector or placeholder image is not end-to-end evidence.

