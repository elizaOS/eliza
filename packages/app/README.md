# @elizaos/app

Eliza application host, renderer, and native platform tooling for web, desktop, iOS, and
Android.

`@elizaos/app` is the Node host API. Use `@elizaos/app/browser`
for renderer composition, `@elizaos/app/auth` for request authorization,
and `@elizaos/app/dev-tools` for launcher diagnostics. Import shared contracts,
UI and authentication from their owning packages; the host barrel does not relay them.

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

## Disposable hosted Android fixtures

`scripts/mobile/android/hosted-fixture` supplies display/network admission and
bounded diagnostics for fresh GitHub-hosted AOSP fixtures. Mutating setup requires
`emulator-5554`, AVD `test` and a single user 0. Display setup additionally
requires an unsecured observed keyguard; network setup rejects preinstalled
third-party apps. Boot-device admission
is specific to the captured API 35 x86_64 topology. Hosts inject ADB execution and
retain orchestration/output ownership. Never use these helpers to provision a
physical phone or relax their admission checks to fit an arbitrary emulator.
Run `node --test scripts/mobile/android/hosted-fixture/*.test.mjs` for the captured
state and refusal tests; these tests do not establish live emulator qualification.

The `hosted-fixture/webview-provider.mjs` factory adds the pinned Chromium provider
replacement flow. Hosts must supply nonempty system-package exclusions, the SDK
environment, an absolute evidence directory and the explicit
`api35-default-x86_64` fixture acknowledgement. The library never discovers a host
SDK or executes on import. It authenticates the stock backup, archive, candidate
APK, signer, live overlay and restarted framework before reporting provisioning;
runtime feature qualification remains separate. The bundled extractor validates
archive membership even under Python optimization.

WebView-based consumers of `runIsolatedAndroidUserTest` can set `requireWebView`
to wait for provider and RELRO readiness after each secondary-user switch. The
check saves its last observation in `user-verification.json`, has a one-minute
deadline, and performs no provider writes or instrumentation retries. It does
not replace provider-byte admission or runtime feature qualification.

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

External development hosts can use `scripts/lib/dev-process-lifecycle.ts`'s
`waitForDevelopmentReady` with their own health predicate, startup/poll budgets,
child-liveness check and cancellation signal. Probes receive that signal and
must release their resources on cancellation. `scripts/lib/shutdown-drain.ts`
handles owned-child teardown; use process-group delivery and liveness from
`kill-process-tree.ts` when children can outlive their launcher. Product ports,
account matching, inference policy and renderer environment stay with the host.

## External Android consumers

Modules default to app library dependencies. Set `appDependency: false` for
independent application/test modules (for example an updater APK); they remain
addressable Gradle projects without being linked into the consumer app.

`scripts/mobile/android/consumer-host.mjs` generates an owned external Gradle
project from explicit identity, manifest, variant, source and dependency data.
It copies no product UI or native service tree. Input paths use declared consumer,
upstream or dependency roots; selected native files can be copied without admitting
whole plugin source directories. Existing unmarked projects, identity changes,
unowned-file collisions and symlink escapes are rejected. Generated ownership
permits regeneration and removal of formerly selected generated files while
preserving other build outputs. Hosts keep authored manifests/resources outside
the generated project and supply already-verified optional runtime payloads. The
generator owns the non-translatable `app_name` brand string; host resources must
not redefine it. Other UI strings can use the host's localized resource directories.

The reviewed consumer toolchain remains Gradle 8.13 / AGP 8.13 / Kotlin 2.2.20 /
JDK 21, independently of the full app's newer default wrapper. The distribution
and shared wrapper JAR are hash pinned. Run the filesystem contract with
`node --test scripts/mobile/android/consumer-host.test.mjs`; with SDK 36 and
build-tools 36.0.0, `node scripts/mobile/android/qualify-consumer-host.mjs` builds
two independent identities and checks eight host variant APKs plus four separate
companion APKs. Linked-library compilation and companion asset isolation are checked.
Reports go to root `test-results/android-consumer-host`. This is build/manifest
qualification, not installed service, HOME-role, AOSP or device acceptance.

Shared local speech sources and reproducible runtime/model tooling are documented
in [local speech](scripts/local-speech/README.md). The source-export resolver in
`scripts/lib/consumer-source-resolver.mjs` composes declared Eliza source exports
for independent Bun hosts; consumers retain their source pin, credentials and policy. `scripts/lib/immutable-workspace-source.mjs`
authenticates prepared workspace files against an exact commit, including ignored
files and Git stat-cache bypasses. Hosts declare their generated metadata/output
paths; declared Turbo outputs and dependency directories are allowed, while
tracked source bytes remain immutable. Git submodules require separate admission.

Shared task gateways, document packaging and consent-aware research APIs are
documented in [the host package](../host/README.md).

External product APK tests can compose `scripts/lib/isolated-android-test.mjs`.
Supply explicit package/test identities, ABI, fixture AVD name, Android user, APK
paths and a report directory. The host must own the disposable AVD and any
secondary-user/provider fixtures; an emulator property alone is not ownership.
It validates both APK identities and the instrumentation target before installing,
leases the emulator, refuses existing package data across users, requires complete
instrumentation, removes its packages after each variant and checks unchanged HOME.
There are no default command/instrumentation deadlines: callers may supply
`commandTimeoutMs`, `instrumentationTimeoutMs`, `cleanupTimeoutMs` and an
AbortSignal. ADB/AAPT work is cancellable; cleanup ignores the aborted operation
signal, force-stops owned targets and uses its separate caller deadline. If either
stop fails, it retains both packages and reports `cleanupDeferred`; recover the
owned fixture explicitly before another run. Callbacks
receive the signal and must cooperate with cancellation before returning. The
lease follows the caller environment and remains held for a live process, rather
than expiring during long instrumentation. Product callbacks own controlled
fixture provisioning; this runner does not authorize live integrations. Use `testOutputPath` for reports produced inside this checkout.

`scripts/lib/isolated-android-user.mjs` supplies the secondary-user lifecycle for
caller-owned emulators. Hold the canonical device lease across the entire call;
supply the exact AVD, stock HOME package, a bounded command executor and a durable
record callback. It restores owner 0 independently of cancellation. The scenario
must settle device work and return `{cleaned: true}` only after proving its package
cleanup; missing proof or a thrown scenario retains the user for explicit recovery.
It does not provision providers, grant permissions or install product packages.

`scripts/lib/isolated-android-user-test.mjs` composes both lifecycles under one
lease. Supply the test options above, `homePackage`, `userName`, positive command
and cleanup deadlines, and a new evidence directory; omit `androidUser` and
`deviceLease`. It records `user-verification.json`, restores owner 0 after test
failure, and removes the secondary user only with matching fresh package-cleanup
evidence. Product hooks still own permissions and fixture assertions.

`scripts/lib/android-fixture-observation.mjs` reads a named SharedPreferences
string, package stopped state, or exact notification key through the harness's
ADB executor. Supply its explicit secondary user and package identity. These
observations never start instrumentation or an Activity, which would interfere
with pending-alarm/reboot evidence. Product code owns envelope schemas and
fixture assertions; the helper does not retain unrelated preferences or bodies.

For installed upgrades, each variant supplies baseline `apk`/`testApk` and an
`upgrade: {apk, testApk}` candidate pair. Both pairs are admitted before device
mutation. `runnerArgs` seeds the baseline; `upgradeRunnerArgs` verifies the
candidate with the same strict class/method selection. `beforeUpgrade` runs after
baseline instrumentation; `afterUpgrade` runs after replacing the app but before
replacing the test APK, allowing product intent-preservation checks. Separate
phase logs and hashes retain evidence. Installed APK bytes are verified after
installation, before replacement and before removal. Changed installed code
retains both packages for explicit recovery instead of deleting an unknown build.

The isolated Android harness also accepts an explicit unique `testClasses` list
instead of `testClass`, with the complete `expectedTests` count across that suite.
For one exact method, supply `testMethod` with one class and `expectedTests: 1`;
the completed method identity must match before acceptance.
It freezes the selection before asynchronous work, checks every requested class
through the same strict instrumentation parser, and rejects missing or unexpected
classes while retaining owned-installation cleanup. This supports product
platform profiles without duplicating APK admission, leasing or teardown.

Consumer Android hosts can use `scripts/lib/consumer-android-runtime.mjs` to build
and stage a pinned mobile runtime with byte provenance, supplying their own
skills and gateway callback. Development checkout inspection lives in
`scripts/lib/committed-source.mjs`; APK document integrity verification lives in
`../host/native-host/android-documents.mjs`.

`development-probes.ts` provides dependency-light TCP and authenticated JSON
readiness transports for development hosts. TCP success does not identify an
owner; JSON probes reject redirects and bound the body read. Hosts retain
identity, readiness predicates and process reuse policy.

`createDevelopmentProcessScope` composes owned child registration and signal
cleanup with the existing process-group drain. It never adopts or restarts a
process. Hosts choose commands, environments, readiness and diagnostics; call
`dispose` in finally. `waitForClose` remains valid after an early close event.

`scripts/mobile/android/build-consumer.mjs` runs an external consumer's admission and
sync commands, assembles selected app distributions (debug, unsigned release and
instrumentation), runs lint and product APK verification, then archives only the
selected APKs plus verification manifest and host metadata. It never signs, installs
or publishes a release. Hosts select environment, distribution names and archive
identity. Missing build outputs or failed verification prevent archive publication.
Run `node --test scripts/mobile/android/build-consumer.test.mjs` for ordering, failure
and stale-artifact isolation checks.

Consumer `runIsolatedAndroidTest` campaigns admit exactly the selected runner by
default. Hosts whose test APK declares other runners must list their class names
in `additionalInstrumentationRunners`; every declaration must target the same
application package, with no missing, duplicate, or undeclared runners. This
changes APK admission only: instrumentation still executes the selected `runner`.

For installed upgrades, each `variants[]` entry and its `upgrade` artifact may
set `additionalInstrumentationRunners` independently. Omission inherits the
campaign default; an explicit empty list admits only the selected runner.
Every artifact must match its own exact declaration set before any APK installs.
This supports historical test APKs without admitting undeclared candidate runners.

Scenario hooks can call `context.instrumentPhase(name, runnerArgs)` after both
owned APKs are installed. Each phase keeps the campaign's exact test selection,
APK hash checks, user, timeout and strict result parser. Names must be unique
letters/digits/underscores/hyphens starting with a letter. Results are recorded in
`variants[].phases` and output in `<variant>-phase-<name>.log`. Runner extras
cannot override test selection. Cleanup hooks may run a final fixture phase even
after cancellation; failed or partial installs do not expose this function.

Consumer APK audits can import `parseXmlTree` and `manifestFacts` from
`scripts/lib/android-manifest-facts.mjs`. These pure helpers decode aapt xmltree
and badging output without invoking an SDK or reading files. They report explicit
manifest declarations, not Android's effective permission/export defaults or a
release verdict. Missing application attributes remain null; hosts own component
allowlists, expected package identity and release policy. `parseXmlTree` accepts
a `decodeAttribute` option for callers such as Play-policy inspection that need
normalized values instead of the default raw strings and hexadecimal integers.

`android-fixture-reboot.mjs` resumes an existing secondary fixture user after a
verified emulator reboot under the caller’s live device lease. It checks the
changed kernel boot ID and unlocked user without launching the target app or
instrumentation; callers retain external alarm observation and cleanup.
