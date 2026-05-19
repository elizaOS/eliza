# retinaface.cpp — Phase 3 placeholder

ggml port of RetinaFace (MobileNet 0.25× backbone) for face detection.

**Status: not started.** See `plugins/plugin-vision/VISION_RUNTIME_MIGRATION.md`
("Phase 3 plan" / "RetinaFace (face detection)") for the conversion strategy.

Replaces:
- `src/face-recognition.ts` SSD-MobileNet-v1 face detector (face-api.js).
- `src/face-detector-mediapipe.ts` BlazeFace alt path (stubbed; was onnxruntime).

Reference checkpoint: `biubug6/Pytorch_Retinaface`, MIT-licensed.
