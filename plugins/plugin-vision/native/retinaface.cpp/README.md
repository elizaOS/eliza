# retinaface.cpp — Phase 3 planned port

ggml port of RetinaFace (MobileNet 0.25× backbone) for face detection.

**Status: planned.** See `plugins/plugin-vision/VISION_RUNTIME_MIGRATION.md`
("Phase 3 plan" / "RetinaFace (face detection)") for the conversion strategy.

Replaces:
- `src/face-recognition.ts` SSD-MobileNet-v1 face detector (face-api.js).
- `src/face-detector-mediapipe.ts` BlazeFace alt path (deprecated migration shim; was onnxruntime).

Reference checkpoint: `biubug6/Pytorch_Retinaface`, MIT-licensed.
