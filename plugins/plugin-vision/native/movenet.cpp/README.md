# movenet.cpp — Phase 3 planned port

ggml port of Google MoveNet (MultiPose Lightning) for keypoint detection.

**Status: planned.** See `plugins/plugin-vision/VISION_RUNTIME_MIGRATION.md`
("Phase 3 plan" / "MoveNet (pose)") for the conversion strategy.

Until this port lands, `src/vision-models.ts::detectPoses` continues to depend
on `@tensorflow/tfjs-node` + `@tensorflow-models/pose-detection`. Those deps
are scheduled for removal once MoveNet ggml is built.
