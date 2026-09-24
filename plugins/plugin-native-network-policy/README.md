# @elizaos/capacitor-network-policy

Capacitor plugin that surfaces Android `metered` and iOS `isExpensive`/`isConstrained`
network-link hints to Eliza agents running on mobile. Unknown or unsupported hints
are null; only an observed unmetered path may authorize automatic downloads.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-network-policy build  # build
bun run --cwd plugins/plugin-native-network-policy test   # tests
```
