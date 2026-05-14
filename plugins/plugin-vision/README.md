# ElizaOS Vision Plugin

A powerful visual perception plugin for ElizaOS that provides agents with
real-time camera integration and scene analysis capabilities. This plugin
enables agents to "see" their environment, describe scenes, detect people and
objects, and make decisions based on visual input.

## Features

### Phase 1 (Implemented)

- ✅ Camera detection and connection (platform-specific)
- ✅ Real-time frame capture and processing
- ✅ Scene description using Vision Language Models (VLM)
- ✅ Motion-based object detection
- ✅ Basic person detection with pose estimation
- ✅ Configurable pixel change threshold
- ✅ Image capture action with base64 attachments
- ✅ Non-dynamic vision provider (always active)
- ✅ Integration with autonomy plugin (kill switch)

### Phase 2 (Implemented)

- ✅ Enhanced object detection with COCO-like classification
- ✅ Advanced pose detection with keypoint estimation
- ✅ Improved person detection and tracking
- ✅ Object classification (person, monitor, chair, keyboard, furniture, etc.)
- ✅ Configurable computer vision models
- ✅ Fallback to motion detection when CV is disabled

### Phase 3 (Implemented)

- ✅ Real-time object tracking with IDs
- ✅ Face detection and recognition
- ✅ Screen capture and OCR integration
- ✅ Entity tracking with persistent IDs
- ✅ Multi-display support
- ✅ Circuit breaker pattern for error resilience
- ✅ Florence2 model integration for advanced scene understanding
- ✅ Worker-based processing for high-FPS operations

### Phase 4 (Planned)

- 🔄 WebAssembly (WASM) integration for browser compatibility
- 🔄 Gesture recognition
- 🔄 Emotion detection
- 🔄 Advanced scene understanding and spatial relationships

### WS4 — Native ONNX backends + lifecycle (Implemented)

- ✅ **RapidOCR / PP-OCRv5** via `onnxruntime-node` — replaces Tesseract.js
  as the default OCR backend. ~80 MB total, sub-second on CPU, multi-language.
  Models fetched on first use to `$ELIZA_STATE_DIR/models/rapidocr/`.
  Fallback chain: RapidOCR → Apple Vision (iOS/macOS, owned by plugin-ios)
  → Tesseract.js (last-resort).
- ✅ **YOLOv8n / YOLOv11n** via `onnxruntime-node` — replaces COCO-SSD.
  Class-filterable: a dedicated `PersonDetector` uses the same model with a
  `person`-only filter.
- ✅ **MediaPipe BlazeFace** (preview) — alternative face detector. Kept
  behind a manual flag until validated on each platform; `face-api.js`
  remains the default.
- ✅ **Dynamic load/unload** — `VisionServiceLifecycleManager` ties each
  sub-service (YOLO / OCR / face / pose / Florence2) to the WS1 memory
  arbiter (when registered) via the `IModelArbiter` contract. Idle watchdog
  releases sub-services after `idleUnloadMs` (default 60s). On
  memory-pressure events the coldest holders are released first.
- ✅ **Eliza-1 vision bridge** — when the runtime exposes an eliza-1
  `IMAGE_DESCRIPTION` handler (signalled by `ELIZA1_VISION_HANDLER_PRESENT`
  or an `eliza1-vision` service), `VisionService` routes scene description
  there first. Local Florence-2 stays as the fallback.
- ✅ **Camera/screen toggle API** — `enableCamera()`, `disableCamera()`,
  `enableScreen(displayIds?)`, `disableScreen()` on the service +
  matching `enable_camera` / `disable_camera` / `enable_screen` /
  `disable_screen` ops on the action surface.
- ✅ **MobileCameraSource contract** — JS surface for native Capacitor /
  AOSP camera bridges (`src/mobile/capacitor-camera.ts`). plugin-aosp (WS8)
  and plugin-ios (WS9) wire native sides on top of this.

#### Per-platform notes

- **Linux x64 / arm64** — onnxruntime-node ships prebuilt CPU wheels.
  All ONNX backends run on CPU EP.
- **macOS arm64** — onnxruntime-node CPU wheel available. Pass
  `executionProviders: ['coreml','cpu']` to opt into CoreML acceleration.
  Apple Vision is the preferred OCR backend on darwin once WS9 lands.
- **Windows x64** — onnxruntime-node CPU wheel available. DirectML EP can
  be enabled via `executionProviders: ['dml','cpu']`.
- **iOS / Android** — `onnxruntime-node` is **not** the right backend on
  mobile. plugin-ios (WS9) bridges to CoreML / Apple Vision via Swift;
  plugin-aosp (WS8) bridges to NNAPI / ML Kit via JNI. Both register a
  `MobileCameraSource` so the runtime API stays platform-agnostic.

## Installation

### TypeScript (Primary)

```bash
npm install @elizaos/plugin-vision
# or
cd plugins/plugin-vision
bun install
bun run build
```
### Camera Tools Required

The plugin requires platform-specific camera tools:

- **macOS**: `brew install imagesnap`
- **Linux**: `sudo apt-get install fswebcam`
- **Windows**: Install ffmpeg and add to PATH

## Configuration

### Environment Variables

```env
# Camera selection (partial name match, case-insensitive)
CAMERA_NAME=obsbot

# Pixel change threshold (percentage, default: 50)
PIXEL_CHANGE_THRESHOLD=30

# Enable advanced computer vision features (default: false)
ENABLE_OBJECT_DETECTION=true
ENABLE_POSE_DETECTION=true
ENABLE_FACE_RECOGNITION=false

# Vision mode: OFF, CAMERA, SCREEN, BOTH
VISION_MODE=CAMERA

# Update intervals (milliseconds)
TF_UPDATE_INTERVAL=1000
VLM_UPDATE_INTERVAL=10000

# Screen capture settings
SCREEN_CAPTURE_INTERVAL=2000
OCR_ENABLED=true
```

### Character Configuration

```json
{
  "name": "VisionAgent",
  "plugins": ["@elizaos/plugin-vision"],
  "settings": {
    "CAMERA_NAME": "obsbot",
    "PIXEL_CHANGE_THRESHOLD": "30",
    "ENABLE_OBJECT_DETECTION": "true",
    "ENABLE_POSE_DETECTION": "true"
  }
}
```

## Actions

### DESCRIBE_SCENE

Analyzes the current visual scene and provides a detailed description.

**Similes**: `ANALYZE_SCENE`, `WHAT_DO_YOU_SEE`, `VISION_CHECK`, `LOOK_AROUND`

**Example**:

```
User: "What do you see?"
Agent: "Looking through the camera, I see a home office setup with a person sitting at a desk. There are 2 monitors, a keyboard, and various desk accessories. I detected 5 objects total: 1 person, 2 monitors, 1 keyboard, and 1 chair."
```

### CAPTURE_IMAGE

Captures the current frame and returns it as a base64 image attachment.

**Similes**: `TAKE_PHOTO`, `SCREENSHOT`, `CAPTURE_FRAME`, `TAKE_PICTURE`

**Example**:

```
User: "Take a photo"
Agent: "I've captured an image from the camera." [Image attached]
```

### SET_VISION_MODE

Changes the vision mode (OFF, CAMERA, SCREEN, or BOTH).

**Similes**: `CHANGE_VISION_MODE`, `SET_VISION`, `TOGGLE_VISION`

### NAME_ENTITY

Assigns a name to a detected entity for tracking.

**Similes**: `LABEL_ENTITY`, `NAME_OBJECT`, `IDENTIFY_ENTITY`

### IDENTIFY_PERSON

Identifies a person using face recognition (requires face recognition to be enabled).

**Similes**: `RECOGNIZE_PERSON`, `IDENTIFY_FACE`

### TRACK_ENTITY

Starts tracking an entity with a persistent ID.

**Similes**: `START_TRACKING`, `FOLLOW_ENTITY`

### KILL_AUTONOMOUS

Stops the autonomous agent loop (useful for debugging with autonomy plugin).

**Similes**: `STOP_AUTONOMOUS`, `HALT_AUTONOMOUS`, `KILL_AUTO_LOOP`

## Vision Provider

The vision provider is **non-dynamic** (always active) and provides:

- Current scene description
- Camera connection status
- Detected objects count and types
- Detected people count with poses
- Scene change percentage
- Time since last update

### Provider Data Structure

```typescript
{
  visionAvailable: boolean,
  sceneDescription: string,
  cameraStatus: string,
  cameraId?: string,
  peopleCount?: number,
  objectCount?: number,
  sceneAge?: number,
  lastChange?: number
}
```

## Detection Modes

### Motion-Based Detection (Default)

- Lightweight and fast
- Detects movement between frames
- Groups motion blocks into objects
- Basic size-based classification

### Advanced Computer Vision (Optional)

Enable with `ENABLE_OBJECT_DETECTION=true` and/or `ENABLE_POSE_DETECTION=true`

- **Object Detection**: Enhanced object recognition with COCO-like classes
- **Pose Detection**: 17-keypoint pose estimation
- **Better Classification**: Distinguishes between person, monitor, chair,
  keyboard, etc.
- **Higher Accuracy**: Edge detection and color variance analysis

## Integration with Autonomy

- Continuous environmental monitoring
- Autonomous responses to visual changes
- Visual memory persistence
- Scene-based decision making

Example autonomous behavior:

```typescript
// Agent autonomously monitors environment
"I notice someone just entered the room.";
"The lighting has changed significantly.";
"A new object has appeared on the desk.";
```

## Performance Considerations

- Frame processing runs every 100ms by default
- VLM is only called when pixel change exceeds threshold
- Motion detection uses 64x64 pixel blocks with 50% overlap
- Advanced CV models add ~50-100ms processing time per frame
- Memory usage increases with resolution (1280x720 recommended)

## Security & Privacy

- Camera access requires system permissions
- No images are stored permanently by default
- All processing happens locally
- Base64 images in messages are ephemeral
- Consider privacy implications in your implementation

## Architecture

```
plugin-vision/
├── README.md                 # This file
├── package.json              # TypeScript package config
├── src/                      # TypeScript implementation (primary)
│   ├── index.ts              # Plugin entry point
│   ├── service.ts            # Vision service
│   ├── provider.ts           # Vision provider
│   ├── action.ts             # All actions
│   ├── entity-tracker.ts     # Entity tracking
│   ├── screen-capture.ts     # Screen capture
│   ├── ocr-service.ts        # OCR service
│   ├── face-recognition.ts   # Face recognition
│   ├── florence2-model.ts    # Florence2 model integration
│   ├── vision-worker-manager.ts # Worker management
│   └── tests/                # E2E tests
```

## Development

### Running Tests

```bash
# Run E2E tests
cd plugins/plugin-vision
npx vitest

# Run local E2E tests
bun run test:e2e:local
```

### Test Coverage

- Service initialization
- Camera detection and connection
- Scene description generation
- Object and person detection
- Image capture
- Provider integration
- Autonomy integration

## Troubleshooting

### No Camera Detected

1. Ensure camera tools are installed (imagesnap/fswebcam/ffmpeg)
2. Check camera permissions in system settings
3. Try without CAMERA_NAME to use default camera
4. Verify camera is not in use by another application

### Poor Object Detection

1. Ensure good lighting conditions
2. Adjust PIXEL_CHANGE_THRESHOLD (lower = more sensitive)
3. Enable advanced CV with ENABLE_OBJECT_DETECTION=true
4. Check camera resolution (higher is better for detection)

### High CPU Usage

1. Increase frame processing interval in code
2. Disable advanced CV features if not needed
3. Reduce camera resolution
4. Increase pixel change threshold

## Future Roadmap

### Phase 3: WebAssembly Integration

- TensorFlow.js WASM backend
- Browser-compatible vision processing
- Real-time object tracking
- Face detection and recognition

### Phase 4: Advanced Features

- Gesture recognition
- Emotion detection
- Scene understanding
- Spatial relationship mapping
- Multi-camera support

## Contributing

Contributions are welcome! Please see the main ElizaOS repository for
contribution guidelines.

## License

MIT

## Support

For issues and feature requests, please use the GitHub issue tracker.
