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

## Android native plugin verification

With the Android SDK, Java 21, workspace dependencies, and a running emulator:

```bash
node packages/app/scripts/android-native-plugins.ts --list
node packages/app/scripts/android-native-plugins.ts --serial emulator-5554
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

The embedded-agent lifecycle lane needs a fresh x86_64 emulator with at least 4 GB
RAM and no installed `ai.elizaos.app`. Run
`node packages/app/scripts/android-native-agent.ts --serial emulator-5580` with
`JAVA_HOME` and `ANDROID_HOME` set. It builds the real mobile Bun bundle and host
service, selects the first-party Agent plugin in a minimal test WebView, verifies
startup, authenticated requests and shutdown, then removes its APKs. Reports and
complete runtime logs go to `test-results/android-native-agent/`. This lane does
not claim model inference, the full renderer flow, or physical-device coverage.
