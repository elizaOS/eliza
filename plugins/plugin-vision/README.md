# @elizaos/plugin-vision

Camera, screen, OCR, object-detection, face-recognition, and scene-context services for
Eliza agents.

Capture is opt-in with `VISION_MODE=CAMERA`, `SCREEN`, or `BOTH` (default OFF). Camera
mode needs a capture utility and OS permission. Native detection/OCR needs compiled
libraries and model artifacts. Unsupported backends fail explicitly.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-vision build  # build
bun run --cwd plugins/plugin-vision test   # tests
```
