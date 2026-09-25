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
bun run build:client  # build
bun run --cwd packages/app test   # tests
```

Turbo builds the host `dist/` before the renderer `web-dist/`. For a renderer-only
rebuild after dependencies are built, use `bun run --cwd packages/app build`.

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
suite seeds SMS, contacts, call logs, location, and credential fixtures. Results
are under repository-root `test-results/android-native-plugins/` and collected by Device E2E.
The app-blocker lane also installs and removes a separate tap-counter fixture APK.
Tests can export captured PNG/MP4 artifacts; the report records their paths, sizes,
and SHA-256 checksums.
Use `--plugin plugin-native-location` for a focused run. `--no-build` is diagnostic
only and labels the report as not built from the checkout.

Bridge contracts cover registration, native result shapes, selected round trips,
and error paths. Phone contracts verify six call types, ordering, filtering, and
transcript persistence across bridge-host recreation. They do not certify cellular
delivery, cloud speech services, or all physical camera/audio hardware. VPN
enforcement and embedded agent startup have separate device scenarios.

For live network-policy transitions, use a stock emulator with one active Wi-Fi
network and no installed Eliza user app:
`node packages/app/scripts/android-native-plugins.ts --serial emulator-5580 --plugin plugin-native-network-policy --network-transitions`.
This opt-in lane changes metering and disables Wi-Fi/mobile data to verify the
unmetered, metered, offline, and restored bridge results. It restores the original
settings and exports each observed result. Device E2E runs this lane before the
full plugin suite.

The embedded-agent lifecycle lane needs a fresh x86_64 emulator with at least 4 GB
RAM and no installed `ai.elizaos.app`. Run
`node packages/app/scripts/android-native-agent.ts --serial emulator-5580` with
`JAVA_HOME` and `ANDROID_HOME` set. It builds the real mobile Bun bundle and host
service, selects the first-party Agent plugin in a minimal test WebView, verifies
startup, authenticated requests and shutdown, then removes its APKs. Reports and
complete runtime logs go to `test-results/android-native-agent/`. It also runs the production filesystem service in two child Bun processes using
the packaged runtime and private app storage, checking persistence, invalid paths,
and symlink rejection. Proof includes the actual app UID and SELinux context.
This lane does not claim the alternate Capacitor filesystem backend, model
inference, the full renderer flow, or physical-device coverage.

Add `--embedding` to run the production framed inference host and JNI encoder
against the BGE model packaged in the APK. This builds CPU libraries for ARM64
and x86_64, requires the pinned llama.cpp submodule and Android NDK, and rejects
`ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1`. It checks complete Unicode input, typed
oversize/artifact rejection, release/reload, and 30 warm requests; the report
exports complete 384-dimensional vectors and timing evidence. It also exercises
the registered Capacitor BGE bridge from a real WebView, including tokenization,
embedding, admission rejection, and context release.

Use `--speech-model-dir <directory>` instead of `--embedding` for CPU Kokoro
transport and PCM diagnostics through the framed host. Supply `kokoro-82m-v1_0.gguf` and `af_sam.bin`
from the pinned assets in `plugins/plugin-native-inference/src/aosp-voice-download.ts`.
The test verifies their hashes inside the installed APK, checks speed, input
rejection and release/reload, and exports full PCM plus a playable WAV. A passing
diagnostic does not qualify speech intelligibility: the report explicitly marks
it `unqualified`. Optimized and scalar output failed independent recognition of
the expected phrase while the recognizer control passed; the model/forward-path
defect remains unresolved (issue #30679). Diagnosis needs a matched canonical
reference and the first divergent tensor. Microphone capture, phonemization and
physical speaker playback are outside this IPA-input diagnostic.
