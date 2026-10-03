# @elizaos/native-activity-tracker

macOS-only Swift helper that streams window/app focus and HID idle events to a typed
TypeScript driver.

Requires macOS and Swift; grant the platform permissions needed to observe application focus. Build the native helper before running collection.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-activity-tracker build  # build
bun run --cwd plugins/plugin-native-activity-tracker test   # tests
```
