# @elizaos/voice-bench

Voice pipeline timing and GPU-profile benchmark helpers. Real pipeline measurements require a configured inference backend.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-local-inference/native/voice-bench test   # tests
```

No standalone build script is defined; this package is consumed or executed from source.
