# @elizaos/plugin-native-phone

Android dialer overlay + iOS Phone Companion (pairing, chat-mirror, remote-session) for
Eliza agents.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-phone build  # build
bun run --cwd plugins/plugin-native-phone test   # tests
```
