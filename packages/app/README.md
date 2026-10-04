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

For a system APK targeting Pixel/Cuttlefish ARM64 and x86_64, set
`ELIZA_ANDROID_TARGET_ABIS=x86_64,arm64-v8a` when running
`bun run --cwd packages/app build:android:system`. Omitting the variable retains
all runtime targets, including the separately pinned RISC-V artifact requirement.

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

The gateway service lifecycle lane requires Android 15+:
`node packages/app/scripts/android-gateway-lifecycle.ts --serial emulator-5580`.
It compiles the production service into a disposable minimal Activity host and
uses Android's real foreground-service timeout to verify shutdown, exhausted-budget
rejection, and foreground recovery in local, cloud, and cloud-hybrid modes. It
restores the timeout setting and removes its package afterward. This tests the
service lifecycle, not full MainActivity behavior or WebSocket delivery.

The embedded-agent lifecycle lane needs a fresh x86_64 emulator with at least 4 GB
RAM and no installed `ai.elizaos.app`. Run
`node packages/app/scripts/android-native-agent.ts --serial emulator-5580` with
`JAVA_HOME` and `ANDROID_HOME` set. It builds the real mobile Bun bundle and host
service, selects the first-party Agent plugin in a minimal test WebView, verifies
startup, authenticated requests and shutdown, then removes its APKs. Reports and
complete runtime logs go to `test-results/android-native-agent/`. It also runs the production filesystem service in two child Bun processes using
the packaged runtime and private app storage, checking persistence, invalid paths,
and symlink rejection. Proof includes the actual app UID and SELinux context.
A third test exercises the Capacitor filesystem backend across recreated WebViews,
with native Documents byte checks and fixture cleanup. It bundles the production
service with real core leaves and the renderer bootstrap. This lane does not claim
model inference, the full renderer flow, or physical-device coverage.

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

## Standalone host speech

Bun hosts may explicitly enable owner-authenticated local speech with
`ELIZA_KOKORO_ENABLED=1`, an absolute `ELIZA_INFERENCE_LIBRARY`, its reviewed
`ELIZA_KOKORO_LIBRARY_SHA256`, and an absolute `ELIZA_KOKORO_MODEL_DIR`.
The worker requires ABI 14 or later, the pinned Kokoro 82M v1.0 GGUF and
`voices/af_bella.bin`; it does not download assets or use a cloud fallback.
`GET /api/tts/kokoro/status` reports readiness. `POST /api/tts/kokoro` accepts
only `{ "text": "..." }` (1–500 characters) and a UUID `X-Request-Id`, returning
mono PCM16 WAV at 24 kHz. Both require an active owner session, not merely the
host's static API token, and are available only in local runtime modes.

Each server owns its worker and replay ledger. Runtime replacement stops the
old worker; closing the server prevents further speech startup. Cancelling a
request destroys its worker context and a subsequent request initializes a
new one. Direct compat-handler hosts must call `closeStandaloneKokoro(state)`
on shutdown and `stopStandaloneKokoro(state)` before replacing the runtime.

With the same reviewed native asset environment, run
`bun run --cwd packages/app test:tts:standalone` for real HTTP policy, durable
SQLite session, native speech, replay, host-isolation and cancellation checks.
The test writes synthetic audio and a report under
`test-results/standalone-kokoro-http`; it fails if assets are unavailable.
This qualification does not prove browser playback or Android execution.

### Android secure-store broker

Embedding Android hosts can set `ELIZA_ANDROID_SECURE_STORE_SOCKET` to their
app-owned broker's abstract socket name (without the leading NUL byte). The host
captures it when constructing the secure store; an unset or empty value uses
`ai.elizaos.app.secure-store`. An explicit factory socket path takes precedence.
The embedding app must start the corresponding app-UID-only Keystore broker;
this option changes client routing, not broker permissions or availability.

## External Android consumers

Shared local speech sources and reproducible runtime/model tooling are documented
in [local speech](scripts/local-speech/README.md). The source-export resolver in
`scripts/lib/consumer-source-resolver.mjs` composes declared Eliza source exports
for independent Bun hosts; consumers retain their source pin, credentials and policy.

Consumer hosts can use `native-host/task-runtime-gateway.mjs` for authenticated
SQLite task lifecycles and explicit domain-route extensions. Document/canvas
bundling and verified ARM64 packaging live in `native-host/build-document-runtime.mjs`
and `native-host/android-documents.mjs`; consumers supply reviewed source identity,
canvas version and locked package records. Run `bun run test:consumer-host` here.
The renderer gateway and Cloud services remain owned by `packages/agent/native-host`
and `packages/auth/native-host`; these build helpers do not provide device acceptance.

Native hosts can compose `native-host/trace-queue.mjs`, `trace-transport.mjs` and
`database-lease.mjs` for opt-in, encrypted research uploads. Hosts must supply an
explicit `validateEvent` policy, private database path/key, authenticated collector
and lifecycle/cancellation ownership. The queue retains events until the collector
acknowledges the exact batch durably; overflow records a visible gap and withdrawal
persists across restart. Event IDs remain database indexes, so validators must keep
identifiers free of private content. Study definitions, measurement projection and operator UI belong to the host. Uploads never
start merely by importing these modules. Caller-owned abort signals cancel HTTP
work; the owner should abort pending transport before awaiting worker shutdown.


`research-store.mjs` and `research-server.mjs` provide the opt-in collector: private
AES-GCM SQLite records, named operator/device roles, enrollment revisions,
consent-aware ingestion, withdrawal, key rotation and structural-event routes.
`measurementPolicy.validateDataset` and `.report` are explicit trusted host
callbacks; the dataset envelope retains study, participants, tasks and coverage
so withdrawal removes the participant's evidence. The shared server accepts an
optional `readAsset` callback for the host's fixed console assets. It never serves
application files by arbitrary request paths.

`task-trace-capture.mjs` reads the existing owner-scoped task journal and emits
pseudonymous structural events, excluding task text and connector content.
`research-capture-host.mjs` composes the collector, encrypted queue, exclusive
lease and caller-cancelled transport. Its explicit start/stop lifecycle preserves
consent and current-owner fences; importing it starts no collection. Run the
native-host tests for real SQLite/HTTP evidence, including stop during an
unanswered request. These modules do not authorize enrolling real participants.
