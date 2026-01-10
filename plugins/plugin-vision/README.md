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

### Phase 3 (Planned)

- 🔄 WebAssembly (WASM) integration for browser compatibility
- 🔄 Real-time object tracking with IDs
- 🔄 Face detection and recognition
- 🔄 Gesture recognition
- 🔄 Scene understanding and spatial relationships

## Installation

```bash
npm install @elizaos/plugin-vision
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

When used with `@elizaos/plugin-autonomy`, the vision plugin enables:

- Continuous environmental monitoring
- Autonomous responses to visual changes
- Visual memory persistence
- Scene-based decision making

Example autonomous behavior:

```typescript
// Agent autonomously monitors environment
'I notice someone just entered the room.';
'The lighting has changed significantly.';
'A new object has appeared on the desk.';
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

## Development

### Running Tests

```bash
# Run E2E tests
npm test

# Run local E2E tests
npm run test:e2e:local
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
