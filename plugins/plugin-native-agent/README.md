# @elizaos/capacitor-agent

Capacitor plugin that exposes agent lifecycle control (start, stop, status, chat, raw
request) to a WebView-hosted Eliza app on iOS, Android, and web/desktop.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-agent build  # build
bun run --cwd plugins/plugin-native-agent test   # tests
```

Native-only host primitives live under Android `runtime/` and `updater/` Java
packages. They share payload extraction, installation identity, request deadlines,
update journaling, qualified-clock projection and cancellable job ownership.
Hosts supply the inventory format, durability/clock adapters and release policy;
these APIs neither authorize an installation nor expose renderer capabilities.
File-based primitives require Android API 26 or newer. Run their portable JVM
crash/recovery tests with JDK 21 and `bun run test:native-host`.

The Android updater `PackageInstallCoordinator` shares package/session validation,
commit and installed-identity reconciliation on API 29+. Hosts supply target
identity, distribution metadata, callback receiver/action, signer, journal,
observation budget and authenticated trust hooks. Production verification remains
mandatory alongside those hooks; test APK acceptance requires explicit host
opt-in. `PreparationFlow` fences each long operation by generation, installed
identity and cancellation. It cannot install packages or select a trust authority.
Its portable contract is included in `test:native-host`. Qualify the host adapter
separately with real Android install/recovery tests; journal tests alone do not
prove silent-install authority or product health.
`LocalCredentialBroker` is a private loopback HTTP transport for the embedded
native process. Hosts inject separate primary and pending-enrollment stores plus
a nonempty private token. It is not a Capacitor method: do not pass that token or
credential responses to the renderer. The host owns token generation and broker
lifetime. Storage failures return a generic error without credential logging.
`LocalCredentialBrokerInstrumentedTest` exercises the TCP contract on Android;
the same contract has a `main` entrypoint for JDK 21 with `org.json` on the classpath.
Consumers should additionally test their real encrypted-store adapter and restart
lifecycle. This transport does not authenticate a Cloud account by itself.

`LocalRuntimeHttp` supplies bounded JSON HTTP exchange with an absolute socket
deadline and injected monotonic clock. It only connects to loopback; the host
must authorize its route and provide its private token and response-size limit.
It deliberately contains no product route catalog. The instrumented contract
also covers this client with real fixed-length, chunked, close-delimited,
oversized, truncated and delayed responses.

`AndroidRuntimeDirectories` supplies the Android durability adapter for runtime
bundle publication and secures an app-owned parent directory to mode 0700.
It rejects symlinks and foreign ownership, and verifies inode identity after
chmod. Hosts retain directory layout and startup policy. Its Android instrumented
test exercises real permissions and fsync, including invalid targets.

`native-host/android-runtime-inventory.mjs` stages the matching Android bundle
inventory from an explicit agent asset directory and native library directory.
Archive blobs preserve gzip bytes through aapt and install beside the immutable
bundle for PGlite. Hosts supply exact directory exclusions and an optional
inventory `format` (default `eliza-runtime-v1`), and package the returned
`assets/agent-runtime.inventory` plus assets. Hosts using ota-trust declare the same
format and exclusions in their host policy. This does not sign or authorize a release.
The native host suite consumes a Node-produced inventory with the actual Java
extractor and checks restart reuse, archive bytes and tamper rejection.

`NativeStorageDiagnostic` runs a disposable SQLite write/close/reopen/integrity
probe in a dedicated no-backup namespace on API 26+. Hosts supply the namespace,
absolute elapsed-time deadline, database-byte budget and cleanup entry limit.
A private no-follow file lock fences orphan cleanup; unknown entries, links and
foreign ownership reject before deletion. It never opens application databases
or declares an update healthy. Android tests cover readback, orphan cleanup,
expired/invalid policy and unsafe files while preserving an external sentinel.

`ReconciliationScheduler` persists local package-readback jobs without network,
charging or idle constraints. Hosts supply distinct job IDs and the declared
service. `ReconciliationJobService` owns bounded workers and cancellation/late
completion fencing through `JobRunRegistry`; hosts bind the readback operation.
Neither component initiates an installation. The consumer must qualify actual
Android job dispatch and reboot persistence alongside its install/recovery tests.

`NativeHealthService`, `NativeHealthEvidence` and updater `NativeHealthClient`
share native observation IPC on API 29+: signature/sender-UID checks,
nonce/version/deadline binding, bounded worker admission and installed-identity
rechecks. Hosts declare the signature-protected service, supply component
identities, positive request/UI budgets and runtime/storage/UI observation ports.
The client enforces its absolute deadline independently of the service. Schema 5
supports standalone/launcher distributions and fixed runtime/UI observation states;
reports never mark a journal healthy or authorize recovery. The Android contract
checks malformed/stale/inconsistent evidence. Hosts must separately qualify actual
IPC, process death and observation providers in their packaged applications.

`WebViewHealthObserver` tracks one host Activity/WebView on the main thread and
serves deadline-bound observations off the main thread. Hosts supply a trusted
HTTPS origin and a read-only JavaScript expression returning a boolean; product
DOM/content policy stays in that expression. The shared wrapper guards the DOM
origin and supplies `visible(element)` for ancestor CSS and viewport checks. Resume/pause/destroy transitions,
renderer replacement, URL changes and late callbacks fence results. Expired or
interrupted reads retire their logical request lease; WebView cannot cancel an
already issued evaluation, so late callbacks cannot complete or clear a newer
request. Lifecycle transitions retire pending reads immediately. It never
launches an Activity, navigates a WebView or declares an update healthy. Hosts
must qualify their actual Activity lifecycle and expression in instrumentation.

`NativeProcessSupervisor` owns a host's direct child processes, bounded readiness,
restart budget, per-launch cleanup and generation fences. Hosts supply commands,
credentials, readiness probes and timing policy. Cancelled or retired scopes refuse
late spawns and readiness; a group death retires every child before restarting.
Probes must release their own resources when interrupted; a daemon probe that ignores
interruption cannot publish readiness after its deadline. Detached processes and
process descendants require the host's existing ownership protocol. The canonical
Android service shares the direct-child termination helper while retaining its
detached-agent policy. Portable real-process tests run in `test:native-host`;
`NativeProcessSupervisorInstrumentedTest` checks the primitive with app-domain
processes on Android. Neither suite establishes full agent or foreground-service lifetime.

`InstallerResultReceiver` shares the asynchronous PackageInstaller callback and
journal reconciliation. Hosts declare a non-exported component and supply its
explicit callback action, target package, journal and executor. Rejected worker
submission finishes the broadcast and leaves durable reconciliation to the host.
Transaction, immutable/framework session and optional package identity must match;
success/failure hints never substitute for installed-identity and live-session
readback, and user-action intents are never launched. The Android contract uses
real PackageInstaller sessions; hosts must also qualify actual installation,
callback delivery, process death and cached recovery with their signed fixtures.

### Local runtime health sampling

`health.LocalRuntimeHealth` reads a host-supplied immutable runtime snapshot and
uses the host's authenticated local transport with an explicit per-probe timeout.
It samples the agent status and gateway health/storage protocols, rejects a
changed process lifetime, and rechecks reported process liveness. Transport
failures produce unavailable observations; malformed protocol payloads fail the
read. The host owns current-process binding, transport credentials, budgets and
update admission. The helper neither starts the runtime nor admits an update.
`LocalRuntimeHealthInstrumentedTest` exercises the shared protocol/lifecycle
contract; maintained consumers separately qualify their actual IPC binding.

Hosts must change the runtime instance or epoch whenever a child process is
replaced, including automatic retries: delayed `unchanged` checks use that
identity. Schema-5 consumers supply the UUID identities required by
`NativeHealthEvidence`. A gateway that dies during storage sampling reports
`gatewayResponsive:false` and `taskStorage:unavailable` together.

`PreparedRecovery` reopens cached recovery material through a host-authenticated
authority. It requires the recovery-ready journal phase and matching installed
candidate, checks material distribution, and rejects state or installed-identity
changes during the authority read. It neither discovers nor installs releases;
the installer must repeat current trust and APK checks at commit. Hosts retain
security-floor policy, generated trust bindings and package identity. Its portable
contract is included in `test:native-host`.

`PrivateOAuthCallback` admits a host-configured HTTPS callback and queues it to a
private sink without persistence, logging or renderer output. Hosts must strip
handled Intent data before passing lifecycle events to a WebView, use a bounded
executor and supply coarse delivery-failure handling. The sink must validate state,
PKCE, account identity and single-use exchange. `QUEUED` is transport admission,
not authentication success. Portable JVM coverage is in `test:native-host`; Android
intent/app-link delivery and provider callback registration need host qualification.

`NativeProcessLog` drains child diagnostics with bounded line buffers, literal
secret redaction before truncation, UTF-8 byte-limited rotation and serialized
records across writers in one JVM. Hosts provide a private real parent directory,
file/line limits, single-line secrets and thread/error policy. Newly created files
are mode 0600; symlink/non-file destinations are refused. It does not store model
context or durable events. The portable suite exercises a 32 MiB line under a
12 MiB heap; `NativeProcessLogInstrumentedTest` covers Android file semantics.

`RuntimePrivateFiles` publishes host-selected files with mode 0600 and atomic
replacement, and reads optional single-line UTF-8 inputs with host-selected byte
bounds. The host supplies a real private parent, serialized writes and directory
sync. A sync failure after rename means publication happened but durability is
unknown. Portable tests cover concurrent readers and rejected inputs; Android
instrumentation qualifies the real directory-sync adapter.

`InstalledRuntimeLibraries` refreshes runtime soname aliases against the current
APK install directory and configures the optional installed canvas library. Hosts
supply trusted installed files and a private alias directory, serialize refreshes
and own bundle verification and launch policy. Links are reconstructible state;
this does not load native code or authorize a library. Portable and Android tests
use synthetic files to verify install-path changes and optional-library cleanup.

`native-host/local-credential-client` supplies the private JavaScript client for
`LocalCredentialBroker`. Hosts supply the loopback port, private bearer token,
deadline and optional error copy. It implements read/write/clear without
redirects or retries; a lost write acknowledgement is not proof the write failed.
Malformed responses are errors rather than absent credentials. Never give this
client or token to a renderer. Portable tests use real loopback HTTP with
synthetic storage; Android broker/device integration remains separate.

`NativePreparation` composes discovery, staged byte verification and journal
admission through host-supplied trust, installed-package and qualified-time
ports. `PreparedAuthorizationStore` retains authority material under the journal
lock; `AndroidQualifiedClock` binds authenticated samples to Android boot identity
and elapsed realtime. No clock authority, enrollment or installation policy is
enabled by these adapters. `NativePreparationInstrumentedTest` exercises Android
lock/cancellation/path rejection and persisted clock bounds; it does not establish
live signed-release discovery, installation or recovery acceptance.

`native-host/gateway-artifact` stages and verifies the shared Android gateway
layout, including task-runtime outputs, reviewed upstream modules and mobile DNS
bundling. Hosts supply trusted source/output directories, product/upstream file
lists, DNS dependencies, compiler environment and task build callback. They pin
source identity, serialize staging and publish provenance only after success.
Failed staging can leave partial files: verification rejects source/generated
hash mismatches; this is not an atomic or durable publication API.

`EmbeddedRuntimeLaunch` constructs Android embedded agent/gateway commands and
private base environments from verified installed libraries and trusted host
paths. Hosts retain provider/plugin configuration, account storage identity and
all supervisor/readiness policy. Agent authority is not copied to the gateway.
Port selection is only a hint; children must bind strictly. The portable native
host suite checks environment isolation with a real child process.
`NativeRuntimeSession` composes the existing process supervisor with named process
bindings, redacted log draining, readiness and once-only response epoch fencing.
Hosts provide commands, environment, log policy, readiness probes and active-host
identity. It selects no provider, routes or credentials and never retries requests.
Its portable contract covers replacement during a request and paired startup
failure; Android service, real runtime and device qualification remain host tests.

`EmbeddedRuntimeGroup` orders agent readiness, private token/binding publication,
credential-broker attachment and gateway readiness inside one existing session
scope. Hosts supply commands, readiness probes, a private publisher and broker
custody. The publisher receives the standard agent-token, gateway-token and
credential-binding.json names; hosts retain storage layout and binding schema.
Endpoints alone do not prove readiness: requests still need session fencing.
Portable tests use real authenticated loopback child processes and verify broker
cleanup and cancellation between startup stages.

`RuntimeAssets` supplies bounded, closing asset reads and presence-only checks.
`RuntimeBundleStore.prepareFromAsset` bounds inventory reads before invoking the
same verified immutable bundle preparation path. Hosts retain asset names,
required library lists, storage layout and inventory format; presence does not
establish integrity or readiness.

Source-checkout consumers can use `scripts/updater-contract-fixtures.mjs` to stage
or run the five portable updater contracts in their adapter namespace. This keeps
all assertions and subprocess crash cases upstream while exercising the actual
consumer adapters, including static imports. The caller owns the temporary
directory when staging, or supplies a compiler/JVM budget to the runner, which
owns temporary-directory cleanup and propagates compilation/assertion failures.
Staging rejects unknown fixtures, invalid packages and existing output files; it never rewrites production source.

`RuntimeRequestDispatcher` shares bounded normal/urgent-control queues, serialized-body admission and destruction cleanup. Pause/cancel/abort work uses a separate single-worker lane. Defaults preserve four normal workers, sixteen queued normal requests and eight queued controls; hosts can configure queue bounds. Body limits count UTF-16 serialized JSON units; transport byte limits and route/authentication policy remain mandatory. Rejected work is never retried. `close()` interrupts active work and discards queued work. Portable contracts cover saturation, urgent progress, size boundaries and teardown.

`runtime.EmbeddedRuntimeService` integrates the existing NativeRuntimeSession and
EmbeddedRuntimeGroup with Android Service lifecycle, foreground dispatch, status,
endpoint-bound requests and local health snapshots. Subclasses provide the private
runtime root, notification UI/identity, launch commands and timing/size policy.
Product wrappers retain asset admission, route allowlists, credentials and provider
configuration. Static adapters use the concrete service class so replacement and
shutdown invalidate old requests without retargeting them. No start is triggered by
status or health reads. Consumer instrumentation should exercise actual failure,
restart, stop and health wiring separately from real configured-runtime acceptance.

Hosts that capture an endpoint before request admission must use the snapshot-bound
`NativeRuntimeSession.request(snapshot, ...)` overload. Capture the snapshot before
selecting the endpoint; a lifecycle change then rejects transport admission instead
of allowing a stale endpoint to inherit a newer running epoch.
