# @elizaos/capacitor-desktop

Capacitor plugin that exposes desktop OS capabilities (system tray, global shortcuts,
notifications, window management, clipboard, auto-launch, power monitor, and system
permissions) to Eliza agent UIs running in Electrobun or a browser.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-desktop build  # build
bun run --cwd plugins/plugin-native-desktop test   # tests
```
