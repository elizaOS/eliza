# @elizaos/native-plugin-shared-types

Shared TypeScript type contracts for elizaOS native plugin bridges (Capacitor and
Electrobun).

Type-only bridge contracts exported directly from src/index.ts. No runtime
configuration, separate build, or test runner is defined; validate consumers and run the
package typecheck.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-shared-types typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package.
