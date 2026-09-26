# @elizaos/plugin-native-inference

Native inference workspace for AOSP FFI, Capacitor llama, mobile host bridges, and
Android ML Kit OCR.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-inference build  # build
bun run --cwd plugins/plugin-native-inference test   # tests
```

Android OCR returns actual ML Kit element confidence on the existing 0–100
scale. A successful recognition does not imply 100% certainty. The real ML Kit
bitmap suite validates text, geometry and confidence against engine output.
