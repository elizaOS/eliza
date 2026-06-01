# @elizaos/plugin-vision

Visual perception plugin for elizaOS — gives Eliza agents real-time awareness of their camera feed and/or screen through scene analysis, object/person detection, OCR, face recognition, and entity tracking.

## What it does

- Captures frames from a connected camera (macOS/Linux/Windows) or the host screen.
- Describes scenes by routing images through `runtime.useModel(IMAGE_DESCRIPTION)` — compatible with any registered VLM (local or cloud).
- Detects and tracks people, objects, and faces across frames with persistent entity IDs.
- Reads text on screen via RapidOCR/PP-OCRv5 (ONNX) with Apple Vision and Tesseract.js as fallbacks.
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
| `ENABLE_OBJECT_DETECTION` | `false` | YOLO-based object detection |
| `ENABLE_POSE_DETECTION` | `false` | Pose keypoint detection |
| `ENABLE_FACE_RECOGNITION` | `false` | face-api.js face recognition |
| `ENTITY_TIMEOUT` | `30000` | ms before an inactive entity is evicted from tracking |

All settings can also be prefixed with `VISION_` (e.g. `VISION_CAMERA_NAME`).

## Actions

The plugin registers a single `VISION` action that routes to one of these sub-operations based on explicit `action` parameter or natural-language inference:

| Sub-operation | Trigger examples | What it does |
|--------------|-----------------|-------------|
| `describe` | "what do you see?", "describe the scene" | Returns the current VLM scene description |
| `capture` | "take a photo", "screenshot" | Captures a frame and returns it as a base64 image attachment |
| `set_mode` | "set vision mode to screen" | Switches between `OFF`, `CAMERA`, `SCREEN`, `BOTH` |
| `enable_camera` / `disable_camera` | "turn on the camera" | Toggles camera input |
| `enable_screen` / `disable_screen` | "enable screen capture" | Toggles screen input |
| `name_entity` | "the person is named Alice" | Assigns a display name to the most prominent tracked entity |
| `identify_person` | "who is that?" | Lists tracked people with names and presence duration |
| `track_entity` | "track the person in the red shirt" | Refreshes entity tracking and reports statistics |

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
| Object detection | YOLOv8n/v11n (onnxruntime-node) | COCO-SSD (optional dep) |
| Pose detection | onnxruntime-node | `@tensorflow-models/pose-detection` (optional dep) |
| OCR | RapidOCR/PP-OCRv5 (onnxruntime-node) | Apple Vision (iOS/macOS), Tesseract.js |
| Face recognition | face-api.js | GGML backend, MediaPipe BlazeFace (experimental) |

## Platform notes

- **Node.js only.** Mobile (iOS, Android) uses `MobileCameraSource` bridged by plugin-ios / plugin-aosp.
- **macOS arm64**: CoreML execution provider available for ONNX models.
- **Windows x64**: DirectML execution provider available.
- **iOS / Android**: Bridges to CoreML / Apple Vision (iOS) and NNAPI / ML Kit (Android) via companion plugins.

## Privacy

- Camera access requires OS-level permissions.
- No frames are written to disk by default.
- All inference runs locally unless a remote IMAGE_DESCRIPTION provider is registered.
- Consider access implications before enabling in shared or sensitive environments.

## License

MIT
