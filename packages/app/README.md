# @elizaos/app

Eliza application host, renderer, and native platform tooling for web, desktop, iOS, and
Android.

Start the app and API with `bun run dev` from the repository root. Native targets
require their platform SDKs; available build/install commands are in package.json.
Concurrent worktrees should use `bun run --cwd packages/app dev:shared`. UI changes
require `bun run --cwd packages/app audit:app` and inspection of affected desktop/mobile
captures.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/app build  # build
bun run --cwd packages/app test   # tests
```

Installed-app launch smoke uses `test:sim:local-chat`; iOS local full-Bun inference uses
`test:sim:local-chat:ios:full-bun` against a current installed simulator build.
Use `build:ios:local:sim`, `build:ios:local:device`, and `ios:device:e2e`
for native builds and physical-device tests.

Web subscription settings select a registered product with `VITE_ELIZA_APPLICATION_SLOT`;
agent-backed settings use `ELIZAOS_CLOUD_APPLICATION_SLOT` from the runtime.
These select a product, not a merchant credential or paid entitlement.

Run Android native bridge instrumentation on an attached device or emulator:

```bash
node packages/app/scripts/android-native-plugins.mjs --serial emulator-5554
```

Results are stored under `test-results/android-native-plugins/`. Per-plugin tests
cover self-contained operations and explicit unavailable states; external service
and physical-device behavior requires its own live acceptance run.
