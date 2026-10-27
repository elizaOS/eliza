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

## Startup branding

The static startup view uses `appName` and optional `web.startupLogoPath` from
`app.config.ts`. The mark must be a path in the host public assets; omit it for
text-only startup. Android Cloud embeds the host's local `branding.logoUrl`
(SVG, PNG, JPEG or WebP) because that package omits the public asset tree.
Missing or remote logos use the app name instead. The canonical Eliza host
sets its own marks explicitly.

## Eliza alarms

`/clock` lists this owner's alarms from native Android storage. It provides local
creation, editing, enable/disable and deletion after a native review gesture.
The view also prepares chat requests for the agent. Server reminders and FCM
notifications remain separate. Timers and stopwatch are outside this surface.

Android hosts advertise `clock.alarms.v1`. The existing assistant device-action
service accepts exact `clock_alarm` proposals for set, update, enable, delete,
dismiss, snooze and show. Agent reads use the complete authenticated current
alarm snapshot; proposals bind its native store revision. Native consent checks
the current profile, owner, exact operation, execution claim and revision before
any effect. The durable journal retains the actual native result. An unknown
result never permits automatic replay. Older clients retain the legacy
`clock.handoff.v1/v2` protocol; this Android host does not dispatch those requests.

`ElizaAlarms` persists definitions and occurrence tokens in device-protected
storage and schedules exact `AlarmManager.setAlarmClock` events. The system
receiver restores confirmed schedules after boot, app replacement, clock/timezone
changes or restored exact-alarm access. Weekly schedules follow the phone's local
wall clock and preserve selected Calendar days (Sunday=1 through Saturday=7).
Ringing uses a native foreground service and lock-screen controls with scoped Stop
and Snooze. Delivery requires no WebView, model, Mac connection or network request.
Overlapping occurrences remain queued; stale controls cannot affect a successor.
The app preserves the user's alarm volume and DND settings.

Exact-alarm access and notification access are required to schedule a new wake-up
alarm. Full-screen access controls the lock-screen presentation; an alarm
notification remains available when Android does not allow a full-screen intent.
The Clock view reads these permissions and opens the platform's permission UI.
After initial authenticated enrollment, cached native ownership permits local
Clock reads and controls offline. A known rejected session retires that cache;
existing scheduled alarms remain intact. Credentials never cross the bridge.

Bound chat requests retain their established device executor and selected context;
Clock enrollment does not replace existing binding headers or caller credentials.
Native source compilation and contract tests do not prove installed-device ringing.
A new APK must be built from the changed native sources and tested on the device.

## Development

Set `ELIZA_PGLITE_AUTO_RESET=0` for hosts that must preserve an existing database
on startup failure. The host then reports the original terminal PGlite error
without resetting the database singleton or quarantining the data directory.
Omitting this setting retains the existing automatic recovery behavior.

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/app build  # build
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

Independent Android consumer profiles may use `main`, `androidTest`, `debug`,
`release`, and their declared flavor names in `sourceSets`. Keep test trust and
other debug-only resources in `debug`; they must not enter release artifacts.
Run `node packages/app/scripts/mobile/android/qualify-consumer-host.mjs` from the
repository root with the Android SDK and JDK configured to check real APK isolation.

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
Owned media and notification mirrors run their existing consumer hosts in a fresh,
unlocked Android user. The runner refuses existing fixture packages, restores the
previous foreground user, and removes the test user and packages. Notification
tests use two synthetic producer apps and grant access only inside that test user.
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
transport and PCM diagnostics through the framed host. Supply `kokoro-82m-v1_0.gguf`
(sha256 `165acd9d…`) and `af_sam.bin` (sha256 `68746708…`) from `elizaos/eliza-1` at
revision `1e4c7371`. These are no longer the agent's voice: the AOSP agent now
stages the pinned `mobile-voice` bundle (Paradee-8M + misaki lexicon, Phonon-2 ASR,
Silero VAD) from `plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json`.
The test verifies their hashes inside the installed APK, checks speed, input
rejection and release/reload, and exports full PCM plus a playable WAV. A passing
diagnostic does not qualify speech intelligibility: the report explicitly marks
it `unqualified`. Optimized and scalar output failed independent recognition of
the expected phrase while the recognizer control passed; the model/forward-path
defect remains unresolved (issue #30679). Diagnosis needs a matched canonical
reference and the first divergent tensor. Microphone capture, phonemization and
physical speaker playback are outside this IPA-input diagnostic.

## Mobile voice quality gates

The shipped mobile voice (Paradee-8M TTS and Phonon-2 ASR, both on
libelizainference, no ONNX) is gated by `scripts/voice-quality/host-wer-gate.ts`
on the host and by `scripts/paradee-voice/qualify` on a device. Both use the
pins and thresholds in `scripts/voice-quality/fixtures.json`: TTS round-trip
WER <= 0.08 over the Paradee card samples, the 25 qualify sentences and the
first 200 Paradee held-out sentences; ASR WER <= 0.06 over 100 LibriSpeech
test-clean utterances and `speech-fixture/0.wav`; and an empty transcript for
silence. RTF is reported. The host report goes to `test-results/voice-quality/`.

ASR is Phonon-2 (`asr/phonon-2-fv5.gguf`, Parakeet-TDT 0.6B with five-value
weights, 208,932,352 bytes, sha256 `c0f6ad42…`) on the library's parakeet
backend, which also streams (`ElizaVoiceNative.nativeAsrStream*`,
`NativeAsr.openStream`). The GGUF is not published yet, so stage it by
converting the pinned source and pass it through `ELIZA_VOICE_BUNDLE_FROM`
(`<dir>/asr/phonon-2-fv5.gguf`; the catalog row pins its hash):
`python tools/parakeet/convert_phonon2_to_gguf.py --archive phonon-2.bps.tar.zst
--output phonon-2-fv5.gguf --verify` in the llama.cpp submodule, with the
archive from `FermionResearch/Phonon-2@7e153e40`. Phonon-2 is the only
local ASR model; `ELIZA_ASR_THREADS` sets decode threads. Phonon-2 weights are CC-BY-4.0
(derived from NVIDIA parakeet-tdt-0.6b-v3): ship the attribution and
Fermion's NOTICE. The NOTICE lists CHiME-6 (CC-BY-SA-4.0) and SPGISpeech
(Kensho terms) training audio, which is flagged for review and does not block
a build.

The agent reaches streaming ASR over the bionic UDS: `ElizaBionicInferenceServer`
serves `asr_stream_supported / open / feed / partial / finish / close / cancel`
(`BionicAsrStreams`: one stream per connection, at most 5 s per feed, 120 s per
stream and 4 streams; disconnecting cancels and frees the stream; logs carry
lengths, never text). On the agent side `BionicHostLoader.openAsrStream()` and
`createStreamingTranscriber()` emit partials and use batch `op:"asr"` only when
the host reports `STREAM_UNSUPPORTED`. Before loading the library,
`ElizaVoiceNative` sets `ELIZA_ASR_BACKEND=ggml`, the registered in-tree
backend used by Phonon-2. For `ELIZA_ASR_THREADS`, a process value wins over
the build-time `BuildConfig` value; the default is one thread per big core.

```sh
bun packages/app/scripts/voice-quality/host-wer-gate.ts --librispeech /data/LibriSpeech
# device inputs, then build the qualify app with them:
bun packages/app/scripts/voice-quality/host-wer-gate.ts --librispeech /data/LibriSpeech \
  --export-device-fixtures /tmp/voice-fixtures
packages/app/platforms/android/gradlew -p packages/app/scripts/paradee-voice/qualify \
  -PasrFixturesDir=/tmp/voice-fixtures :app:connectedDebugAndroidTest
```

A device run is owner acceptance; the qualify app only depends on `:paradee-voice`.

## Standalone host speech

Bun hosts may explicitly enable owner-authenticated local speech on
libelizainference (ABI 17 or later). Both workers need an absolute
`ELIZA_INFERENCE_LIBRARY` and its reviewed `ELIZA_INFERENCE_LIBRARY_SHA256`.
They hash every pinned asset before loading native code, do not download
assets, and have no cloud fallback.

- Speech output: `ELIZA_PARADEE_ENABLED=1` and an absolute
  `ELIZA_PARADEE_MODEL_DIR` with the pinned `paradee-8m-v1_1.gguf` and
  `misaki-en-us.lex`. Text is phonemized by the native misaki G2P.
  `GET /api/tts/paradee/status` reports readiness. `POST /api/tts/paradee`
  accepts only `{ "text": "..." }` (1–500 characters) and returns mono PCM16
  WAV at 24 kHz (voice `af_heart`, provider `libelizainference-paradee`).
- Speech input: `ELIZA_ASR_ENABLED=1` and an absolute `ELIZA_ASR_MODEL_DIR`
  with the pinned Phonon-2 GGUF at `asr/phonon-2-fv5.gguf` (build it with
  `bun packages/app/scripts/voice/build-phonon2-gguf.ts`), plus pinned `vad/silero-vad-v5.gguf` as the
  only GGUF in `vad/`. Native Silero VAD rejects non-speech before ASR; speech
  retains the complete input audio. No text model is loaded.
  `GET /api/asr/libelizainference/status` reports readiness.
  `POST /api/asr/libelizainference` accepts a mono PCM16 WAV at 8–48 kHz
  (`Content-Type: audio/wav`, at most 60 s) and returns
  `{ "text": "...", "provider": "local-inference" }`.

Requests need a UUID `X-Request-Id` and an active owner session, not merely the
host's static API token, and are available only in local runtime modes.
Each server owns its workers and replay ledger. A client abort or deadline
cancels the native call (`eliza_inference_cancel_tts` or
`eliza_inference_asr_cancel`) and keeps the worker loaded; a worker that does
not answer within 10 s is killed. After two idle minutes a worker evicts its
weights and reloads them on the next request. Runtime replacement stops the
workers; closing the server prevents further speech startup. Direct
compat-handler hosts must call `closeStandaloneSpeech(state)` on shutdown and
`stopStandaloneSpeech(state)` before replacing the runtime.

With the same reviewed native asset environment, run
`bun run --cwd packages/app test:speech:standalone` for real HTTP policy,
durable SQLite session, native speech, a speech-to-text round trip, replay,
host-isolation and cancellation checks. The test writes synthetic audio and a
report under `test-results/standalone-speech-http`; it fails if assets are
unavailable. This qualification does not prove browser playback or Android
execution.

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
generator owns the non-translatable `app_name` brand string (written under the
generated `eliza-consumer-host/res`); host resources must not redefine it. Other UI
strings can use the host's localized resource directories. Manifests are referenced
where they are, never copied.

`inPlace: true` writes the generated build files into the consumer's own authored
Android directory, beside its standard `app/src` layout: an existing unmarked
directory is admitted, but no authored file is ever replaced. The profile can also
declare, as data:

- `signing`: the four environment variable *names* for the release key store,
  password, alias and key password. Gradle signs releases only when all four are
  set, fails on a partial set by name, and never prints a value. `versionOverride`
  names the release version code/name variables, validated like the identity.
- `buildTypes`: debug/release ABI filters and BuildConfig fields, release resource
  shrinking and Proguard files (both require `releaseMinify`); `kotlin: false`
  leaves a Java-only app without the Kotlin plugin; `preserveRuntimeBytes` keeps
  packaged runtime libraries unstripped, as for `runtimeDirectory`.
- `testMocks`: debug-only Java, resource and manifest sources plus androidTest
  sources attached only when the named switch (Gradle property or environment,
  for example `ELIZA_DEV_ALLOW_TEST_MOCKS`) is exactly `1`; the named BuildConfig
  field is `true` only in those debug variants.
- `admission`: argv commands (no shell) run as tasks before every `preBuild`, and
  `settingsAdmission` commands run before any module is configured.
  `generatedSources` adds build directories those tasks produce; `assetFiles` stages
  named files into the APK assets; `appScripts` applies consumer-owned Gradle files
  for product configuration after the generated policy.
- `generationInputs`: files whose digests the host records; a changed input makes
  the generated host refuse to configure until it is regenerated.
- dependencies may name a `module` with a `toolchainVersion` key to take the
  reviewed toolchain version. A `path` of `.` names a declared root itself.

Modules outside the generated host keep their build outputs under its
`build/modules/<name>`, so shared checkouts and dependency trees stay unchanged.

`scripts/mobile/android/build-consumer.mjs` builds the selected distributions of a
generated host and retains only verified artifacts. Hosts choose the Gradle project
and output directories, `-Pname=value`/`--offline` arguments, where instrumentation
APKs and R8 mappings are kept, a sequential low-disk mode, and the signing
environment names: a signed release keeps `<variant>-release.apk`, an unsigned one
is `-release-unsigned.apk`, and an unsigned release fails when every named signing
variable is set. Stale release outputs from an earlier run are removed first. The
archive is optional. Run `node --test packages/app/scripts/mobile/android/build-consumer.test.mjs`.

`scripts/mobile/android/resident-host-sources.mjs` stages the resident runtime's
Android classes (`RESIDENT_HOST_CLASSES`) into a host's own application package so
`R`, `BuildConfig` and installed component names keep that host's identity. The
host supplies data: abstract socket names for the agent, inference and secure-store
routes, the notification small icon, an optional `0xAARRGGBB` accent and string
resources for the runtime notifications, an optional static environment hook, and
selected shared helpers. The rewrite anchors live here and fail closed when the
upstream source changes; each staged file reports source and generated digests for
the host's provenance receipt. Run
`node --test packages/app/scripts/mobile/android/resident-host-sources.test.mjs`.

The reviewed consumer toolchain remains Gradle 8.13 / AGP 8.13 / Kotlin 2.2.20 /
JDK 21, independently of the full app's newer default wrapper. The distribution
and shared wrapper JAR are hash pinned. Run the filesystem contract with
`node --test packages/app/scripts/mobile/android/consumer-host.test.mjs`; with SDK 36 and
build-tools 36.0.0, `node packages/app/scripts/mobile/android/qualify-consumer-host.mjs` builds
two independent identities and checks eight host variant APKs plus four separate
companion APKs. Linked-library compilation and companion asset isolation are checked.
Reports go to root `test-results/android-consumer-host`. This is build/manifest
qualification, not installed service, HOME-role, AOSP or device acceptance.

The source-export resolver in
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
owned fixture explicitly before another run. A failed or cancelled install without
an acknowledged success also defers cleanup and reports `unacknowledgedInstalls`
with the expected APK hashes. Android can finish that install after the host ADB
process exits, so an absent package at cleanup is not proof that the fixture is
clean. Recover only the exact owned fixture and verified artifact before retrying.
Callbacks
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
With `orphanWatchdog: true` (POSIX only), a detached helper sends SIGTERM to each
child's process group if the host dies without draining it, for example on SIGKILL.

`scripts/mobile/android/build-consumer.mjs` runs an external consumer's admission and
sync commands, assembles selected app distributions (debug, unsigned release and
instrumentation), runs lint and product APK verification, then archives only the
selected APKs plus verification manifest and host metadata. It never signs, installs
or publishes a release. Hosts select environment, distribution names and archive
identity. `lint: false` and `androidTest: false` skip lint and the instrumentation
APKs, and the archive's `build-checks.json` records which of the two ran. A prepare
step may also be a synchronous function or `{ gradleTasks }`, which adds tasks to the
same Gradle run instead of starting another one; a step has exactly one of these
shapes. The generated `variables.gradle` exposes `rootProject.ext.consumerIdentity`
(`appId`, `namespace`) for extra modules.
Missing build outputs or failed verification prevent archive publication.
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

Set `wake: true` to send `KEYCODE_WAKEUP` and `wm dismiss-keyguard` after the
APKs install and before `prepareVariant`. Set `appEvidence: {directory, json,
png}` to copy named files from an app-relative sandbox directory with `run-as`
after the last instrumentation. Each file is saved as `<variant>-<name>` in the
report directory, JSON must parse and PNG must have a PNG signature. Its hash is
recorded in `variants[].appEvidence`, and `collectVariant` receives
`context.appEvidence.{files,json}`. A missing or invalid file fails the variant.
The free-form `evidence` field is unchanged.

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

## Self-hosted realtime voice

Enable `ELIZA_SELF_HOSTED_VOICE_ENABLED=1` and supply `CARTESIA_API_KEY_FILE`
(an owner-private file, mode `0600`) or `CARTESIA_API_KEY` in the API host process.
`VOICE_REALTIME_CARTESIA_VOICE_ID` optionally overrides the Skylar voice. Provider
keys stay on the host. No renderer key or separate voice gateway is required.
The host connects to its own bound socket address and API port for conversation
streaming; a LAN-only listener does not need an additional loopback listener.

The `/api/v1/voice/session` health, consent, mint and WebSocket routes require a
live owner session, including an operator-paired device session; static API keys,
user-role devices and unauthenticated loopback requests cannot mint voice access.
Consent and single-use voice tickets expire after 120 seconds and are invalidated
by a process restart. Auth-session revocation closes admitted sockets. The
selected conversation is checked through the canonical runtime catalog, and
voice turns retain that session's owner authority and the existing text stream,
UI context and cancellation. The process-local usage ceiling is 60 input-audio
minutes per UTC day per host/owner; restarting resets that local counter.
Hosts configured with mandatory `hostAdmission` currently refuse this optional
protocol until continuous protected-host admission is implemented.

Consumer `runIsolatedAndroidTest` can alternatively select a caller-owned disposable
Cuttlefish on `127.0.0.1:PORT`: omit `expectedAvdName` and supply
`expectedCuttlefish: {callerOwned: true, serialNumber, fingerprint}` with exact
`ro.serialno` and `ro.build.fingerprint` values. This lane requires a booted vsoc
instance, enforcing SELinux, the requested ABI and foreground owner user 0. It
pins the kernel boot ID and rechecks instance/image/user/boot before each runner
command, including `context.run` callbacks and cancellation cleanup. Reconnection or reboot
retains installations for explicit recovery rather than deleting from a changed
instance. HOME and browser roles must remain unchanged; the runner does not
repair unrelated role policy. SDK AVD admission is unchanged. Caller ownership
is an explicit assertion, not inferred from a loopback address, and this lane
proves only the selected APK scenarios, not product-image or live integrations.

A third lane admits one owner-approved physical development device: omit
`expectedAvdName` and supply `developmentDevice: {ownerApproved: true, model,
fingerprint}` with the exact `ro.product.model` and `ro.build.fingerprint`. The
adb serial must be the device's `ro.serialno`. The device must not be an emulator,
must have finished booting, enforce SELinux and run owner user 0 in front. The
runner pins the boot ID as for Cuttlefish. Because the device is not reset after
the run, it also records font scale, screen-off timeout, airplane mode, mobile
data, live Wi-Fi state (`cmd wifi status`) and media volume, and fails when one
changed, as it does for HOME and the browser role. A caller that changes one must
restore it. Scenario hooks receive the frozen pin as `context.developmentDevice` in this
lane, so a hook cannot change the identity the runner checks. This
lane is development-device evidence only, not release hardware, a product image
or user acceptance: `verification.json` records `evidenceClass:
"development-device"` and that note.

`buildConsumerAndroidRuntime` accepts `targetAbi: "x86_64"` for an emulator or
Cuttlefish bundle; the default remains `"arm64-v8a"`. The reviewed upstream stager
selects the matching Bun, musl loader and libraries, and the consumer builder
checks their target ELF machine and records the ABI in provenance. A supplied
`bunArchiveFile` uses the selected architecture's verified local archive input.
The host gateway callback receives `{targetAbi}` as its third argument so it can
stage ABI-specific dependencies. Hosts must also select that ABI for runtime
inventory, native document assets and APK packaging. This is bundle integrity
support; installed execution, live services and image boot remain separate tests.
