# retinaface.cpp — planned ggml port

ggml port of RetinaFace (MobileNet 0.25× backbone) for face detection.

**Status: planned.** The runtime face detector today is
`src/face-detector-ggml.ts` (native BlazeFace from `native/face-cpp`).
`src/face-detector-mediapipe.ts` is a compile-time compatibility stub. It
reports unavailable and runs no detector.

Reference checkpoint: `biubug6/Pytorch_Retinaface`, MIT-licensed.
