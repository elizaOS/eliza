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

Web subscription settings select a registered product with `VITE_ELIZA_APPLICATION_SLOT`;
agent-backed settings use `ELIZAOS_CLOUD_APPLICATION_SLOT` from the runtime.
These select a product, not a merchant credential or paid entitlement.

## Android native plugin verification

With the Android SDK, Java 21, workspace dependencies, and a running emulator:

```bash
node packages/app/scripts/android-native-plugins.mjs --list
node packages/app/scripts/android-native-plugins.mjs --serial emulator-5554
```

The runner builds every Android native module and executes its instrumentation
and real WebView/Capacitor bridge contracts. Missing tests, skips, crashes, and
incomplete runs fail. It leases the selected emulator, installs isolated test
packages, and removes them afterward. Physical phones are rejected because the
suite seeds SMS, contacts, location, and credential fixtures. Results are under
repository-root `test-results/android-native-plugins/` and collected by Device E2E.
The app-blocker lane also installs and removes a separate tap-counter fixture APK.
Tests can export captured PNG/MP4 artifacts; the report records their paths, sizes,
and SHA-256 checksums.
Use `--plugin plugin-native-location` for a focused run. `--no-build` is diagnostic
only and labels the report as not built from the checkout.

Bridge contracts cover registration, native result shapes, selected round trips,
and error paths; they do not certify cellular delivery, cloud speech services,
VPN enforcement, embedded agent startup, or all physical camera/audio hardware.
