# Kokoro-82M → CoreML (fused end-to-end) exporter

Produces the **single** `kokoro_5s.mlmodelc` that the iOS on-device TTS path loads (`KokoroCoreMlModel` / `KokoroCoreMlEngine` in `plugins/plugin-native-bun-runtime/ios/Sources/ElizaBunRuntimePlugin/kokoro/`), plus the `vocab_index.json` and `voices/*.json` sidecars.

This directory is part of `packages/training`.

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No standalone wheel build is configured; run the Python sources directly.

Test from `packages/training`:

```bash
python -m pytest
```
