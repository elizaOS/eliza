# @elizaos/plugin-vision

Visual perception plugin for elizaOS — gives Eliza agents real-time awareness of their camera feed and/or screen through scene analysis, object/person detection, OCR, face recognition, and entity tracking.

## What it does

- Captures frames from a connected camera (macOS/Linux/Windows) or the host screen.
- Describes scenes by routing images through `runtime.useModel(IMAGE_DESCRIPTION)` — compatible with any registered VLM (local or cloud).
- Detects and tracks people, objects, and faces across frames with persistent entity IDs.
- Reads text on screen through the generic Apple Vision/doCTR OCR service and the coordinate-aware OCR registry used by computeruse: Windows.Media.Ocr on Windows, Tesseract on Linux when available, and the RapidOCR adapter as the portable fallback.
- Exposes all capabilities through a single `VISION` action and a `VISION_PERCEPTION` context provider.

## Installation

```bash
npm install @elizaos/plugin-vision
```

### Platform camera tools (required for camera mode)

| Platform | Tool |
|----------|------|
| macOS | `brew install imagesnap` |
| Linux | `sudo apt-get install fswebcam` |
| Windows | Install ffmpeg and add to PATH |

Screen capture and OCR work without these tools.

## Enabling the plugin

Add it to your character's plugin list:

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-vision"],
  "settings": {
    "CAMERA_NAME": "obsbot",
    "VISION_MODE": "CAMERA"
  }
}
```

The plugin auto-enables when `config.features.vision` is truthy or `config.media.vision.provider` is set.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `CAMERA_NAME` | auto | Partial name match for camera device selection (case-insensitive) |
| `VISION_MODE` | `CAMERA` | `OFF` / `CAMERA` / `SCREEN` / `BOTH` |
| `PIXEL_CHANGE_THRESHOLD` | `50` | % pixel change required before triggering a VLM scene update |
| `VLM_UPDATE_INTERVAL` | `10000` | ms between VLM scene-describe calls |
| `SCREEN_CAPTURE_INTERVAL` | `2000` | ms between screen captures |
| `OCR_ENABLED` | `true` | Enable OCR on screen tiles |
| `ENABLE_OBJECT_DETECTION` | `false` | ggml YOLOv8n object detection (`native/yolo.cpp`) |
| `ENABLE_POSE_DETECTION` | `false` | Heuristic person detection (ggml pose pending) |
| `ENABLE_FACE_RECOGNITION` | `false` | Native ggml face recognition (BlazeFace + 128-d embed via `native/face-cpp`) |
| `ENTITY_TIMEOUT` | `30000` | ms before an inactive entity is evicted from tracking |

All settings can also be prefixed with `VISION_` (e.g. `VISION_CAMERA_NAME`).

## Actions

The plugin registers a single `VISION` action that routes to one of these sub-operations from the structured `action` / `subaction` / `op` parameter. Mode changes use the structured `mode` parameter, and entity naming uses the structured `name` parameter.

| Sub-operation | Structured parameter example | What it does |
|--------------|-----------------|-------------|
| `describe` | `action: "describe"` | Returns the current VLM scene description |
| `capture` | `action: "capture"` | Captures a frame and returns it as a base64 image attachment |
| `set_mode` | `action: "set_mode", mode: "SCREEN"` | Switches between `OFF`, `CAMERA`, `SCREEN`, `BOTH` |
| `enable_camera` / `disable_camera` | `action: "enable_camera"` | Toggles camera input |
| `enable_screen` / `disable_screen` | `action: "enable_screen"` | Toggles screen input |
| `name_entity` | `action: "name_entity", name: "Alice"` | Assigns a display name to the most prominent tracked entity |
| `identify_person` | `action: "identify_person"` | Lists tracked people with names and presence duration |
| `track_entity` | `action: "track_entity"` | Refreshes entity tracking and reports statistics |

## Vision Provider

`VISION_PERCEPTION` is injected into agent context during turns in the `media` and `browser` contexts. It provides:

- Current scene description text
- Camera / screen connection status and mode
- Detected people (count, poses, facings)
- Detected objects (types)
- Active tracked entities with duration
- Recently-departed entities
- Screen tile OCR text and UI element list (when screen mode is active)

## Detection backends

| Capability | Default backend | Optional / alternative |
|-----------|-----------------|----------------------|
| Scene description | VLM via `runtime.useModel(IMAGE_DESCRIPTION)` | Any registered IMAGE_DESCRIPTION provider |
| Object detection | YOLOv8n ggml via `native/yolo.cpp` (`src/yolo-detector.ts`); build with `bun run build:native` + `bun run build:weights`. Service degrades to motion/heuristic + VLM when the lib/GGUF are absent. | — (TensorFlow.js path removed) |
| Pose detection | Heuristic person detection (motion-derived) | Planned ggml MoveNet port |
| OCR | Generic OCR uses Apple Vision (darwin, when a provider is registered) → doCTR ggml (`native/doctr.cpp`). Coordinate OCR for computeruse prefers Windows.Media.Ocr (Windows) → Tesseract CLI or vendored bundle (Linux) → RapidOCR adapter. | Native/mobile bridges can register platform OCR providers; no ONNX OCR path. |
| Set-of-Marks grounding | `src/som.ts` fuses GGUF YOLO icon boxes + OCR text boxes into a deduplicated, 1-indexed numbered set (icon-over-text suppression + NMS) and renders a numbered-overlay PNG via `sharp`. `src/set-of-marks-provider.ts` registers it into plugin-computeruse's `detect_elements` seam at boot (best-effort; degrades to text-only marks when the GGUF detector is absent). | trycua/cua OmniParser parity (#9170 M9) |
| Face recognition | Native ggml BlazeFace + 128-d embed (`face-detector-ggml.ts`, `face-recognition-ggml.ts`, `native/face-cpp`); disabled until the lib/GGUF artifacts land. No tfjs/face-api.js path. | MediaPipe BlazeFace migration shim is deprecated. |

## Platform notes

- **Node.js only.** Mobile (iOS, Android) registers a `MobileCameraSource` (`src/mobile/capacitor-camera.ts`) bridged by plugin-ios / plugin-aosp.
- **Camera tools** (`imagesnap` / `fswebcam` / `ffmpeg`) are required for camera mode; screen capture and OCR work without them.
- **Native detectors and OCR** (`native/yolo.cpp`, `native/doctr.cpp`, and the coordinate-OCR providers) run through the available host backend. YOLO/doCTR require compiled libraries and GGUF artifacts; Tesseract requires a binary plus traineddata resolved from the vendored bundle or PATH.

## Privacy

- Camera access requires OS-level permissions.
- No frames are written to disk by default.
- All inference runs locally unless a remote IMAGE_DESCRIPTION provider is registered.
- Consider access implications before enabling in shared or sensitive environments.
