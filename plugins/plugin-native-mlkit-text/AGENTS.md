# @elizaos/capacitor-mlkit-text

Capacitor plugin for on-device OCR text recognition through Android ML Kit.

## Purpose / Role

This is a Capacitor plugin, not an elizaOS runtime plugin. It exposes a
`Tesseract`-compatible JavaScript surface (`recognize({ image, psm? })`) so the
renderer-pulled OCR bridge in `@elizaos/plugin-vision` can run native Android OCR
without bundling Tesseract binaries.

The package intentionally avoids checked-in model/native binaries. Android uses
Google ML Kit's text-recognition dependency; web rejects with a clear
unsupported error.

## Layout

```
src/
  definitions.ts   JS contract and word shape
  index.ts         registerPlugin("Tesseract")
  web.ts           unsupported web fallback
android/
  build.gradle
  src/main/AndroidManifest.xml
  src/main/java/ai/eliza/plugins/mlkittext/
    MlKitTextPlugin.kt   Capacitor surface (base64 decode + JS bridge)
    MlKitTextReader.kt   Engine wrapper: ML Kit recognizer + word mapping
  src/androidTest/java/ai/eliza/plugins/mlkittext/
    MlKitTextReaderInstrumentedTest.kt   On-device OCR of a rendered bitmap
```

## Commands

Scripts are defined in `package.json`; run them from the repo root with `bun run --cwd`:

```bash
bun run --cwd plugins/plugin-native-mlkit-text clean           # remove build output
bun run --cwd plugins/plugin-native-mlkit-text build           # build package artifacts
bun run --cwd plugins/plugin-native-mlkit-text typecheck       # TypeScript typecheck
bun run --cwd plugins/plugin-native-mlkit-text lint            # mutating Biome check
bun run --cwd plugins/plugin-native-mlkit-text lint:check      # read-only Biome check
bun run --cwd plugins/plugin-native-mlkit-text format          # write formatting
bun run --cwd plugins/plugin-native-mlkit-text format:check    # read-only formatting check
bun run --cwd plugins/plugin-native-mlkit-text test            # run package tests
bun run --cwd plugins/plugin-native-mlkit-text prepublishOnly  # publish-time build hook
bun run --cwd plugins/plugin-native-mlkit-text watch           # watch TypeScript sources
bun run --cwd plugins/plugin-native-mlkit-text build:unlocked  # bun run clean && tsc && bunx rollup -c rollup.config.mjs
```

## Gotchas

- Keep the plugin name as `Tesseract` for compatibility with the existing UI
  bridge lookup and the stale #9649 branch's renderer contract.
- Do not add committed OCR model binaries to this package. If Android OCR needs a
  downloadable model in the future, stage it through the normal artifact path and
  document the proof.
