# @elizaos/plugin-native-messages

Android SMS overlay plugin for elizaOS — provides an SMS inbox and compose surface
backed by the native `@elizaos/plugin-native-messages/bridge` bridge.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-messages build  # build
bun run --cwd plugins/plugin-native-messages test   # tests
```

The package-owned root TypeScript configuration covers its React view and
native bridge. Production output uses `tsconfig.build.json`.

Reads preserve complete SMS bodies and have no implicit result cap; only an
explicit positive safe-integer limit bounds results. Outbound requests own their
receivers, deadline and teardown settlement. A timeout means unknown send status
and must not trigger an automatic resend. Only the default SMS app persists sent
rows; other apps leave platform-owned persistence alone.
