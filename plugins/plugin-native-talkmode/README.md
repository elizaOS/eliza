# @elizaos/capacitor-talkmode

Capacitor plugin for voice conversations: STT → chat orchestration → TTS, across
browser, iOS, Android, and Electrobun (desktop).

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-talkmode build  # build
bun run --cwd plugins/plugin-native-talkmode test   # tests
```
