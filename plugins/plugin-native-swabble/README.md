# @elizaos/capacitor-swabble

Capacitor plugin that adds wake-word detection and live speech transcription to Eliza
agents across iOS, Android, browser, and desktop (Electrobun/Whisper.cpp).

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-swabble build  # build
bun run --cwd plugins/plugin-native-swabble test   # tests
```
