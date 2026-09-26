# @elizaos/plugin-local-inference

Eliza-1 local inference provider: text generation, embeddings, TTS, ASR, image
generation, and vision description — all served through the elizaOS model-handler
registry without a network call.

Local text, embeddings, speech, and vision use supported native backends and downloaded
model artifacts. Root installation builds/verifies the desktop fused library; GGUF
models download during warmup. See [native/README.md](native/README.md) for native
builds. Missing hardware/models are unavailable, not fabricated inference.

Initial model downloads require a network connection and sufficient disk space. Register this plugin in the agent configuration; select local/cloud routing in Settings → Model Routing.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-local-inference build  # build
bun run --cwd plugins/plugin-local-inference test   # tests
```
