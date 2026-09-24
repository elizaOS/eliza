# @elizaos/plugin-native-contacts

Android address-book overlay app for elizaOS: provides a full-screen UI surface for
browsing, searching, creating, and importing contacts, plus a read-only dynamic provider
that injects address-book context into the agent planner.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-contacts build  # build
bun run --cwd plugins/plugin-native-contacts test   # tests
```
