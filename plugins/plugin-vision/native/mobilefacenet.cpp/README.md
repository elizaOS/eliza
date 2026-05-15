# mobilefacenet.cpp — Phase 3 placeholder

ggml port of MobileFaceNet for 128-d face embeddings.

**Status: not started.** See `plugins/plugin-vision/VISION_RUNTIME_MIGRATION.md`
("Phase 3 plan" / "MobileFaceNet (face embedding)") for the conversion strategy.

Replaces `face-api.js::faceRecognitionNet` (Inception/ResNet variant).

Reference checkpoint: `deepinsight/insightface` MobileFaceNet weights, MIT.

The embedding-compare logic in `src/face-recognition.ts::euclideanDistance`
is reusable as-is; only the model load + forward pass need replacing.
