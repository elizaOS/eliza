# mobilefacenet.cpp — planned ggml port

ggml port of MobileFaceNet for 128-d face embeddings.

**Status: planned.** The runtime embedding path today is
`src/face-recognition-ggml.ts`. It makes 128-d L2-normalized embeddings and
has no face-api.js fallback. Its `euclideanDistance` compare logic is reusable
as-is; only the model load and forward pass differ.

Reference checkpoint: `deepinsight/insightface` MobileFaceNet weights, MIT.
