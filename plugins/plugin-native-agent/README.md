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
`ResidentCredentialStore` shares provider admission, conditional removal and
credential ownership over the host's protected slots. It composes the generic
mutation conductor in `plugin-native-secure-store`. `CredentialShutdownLease`
retains the service start fence after exact stop acknowledgement until its owner
releases it after commit or proven pre-commit cancellation. Failed stop or uncertain
commit stays fenced, and stale release cannot clear a newer request. The retained
`CredentialIntentFence` name delegates to the same secure-store implementation.
File-based primitives require Android API 26 or newer. Run their portable JVM
crash/recovery tests with JDK 21 and `bun run --cwd plugins/plugin-native-agent test:native-host`.

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
`updater.policy.PolicyEngine` decides when to run discovery, download and activation
jobs. It gates them on signed time, device signals (unknown signals defer) and a local
comfort window, and keeps a durable alert ledger. Hosts bind the ports: signed clock,
signal readers, discovery, pending plan and activation. The engine reads no clock and
installs nothing itself. Share one engine per ledger across scheduled jobs; runs
serialize effects and ledger updates. Do not write that ledger from another engine
or process. Its JVM contract is included in `test:native-host`.
`LocalCredentialBroker` is a private loopback HTTP transport for the embedded
native process. Hosts inject separate primary and pending-enrollment stores plus
a nonempty private token. It is not a Capacitor method: do not pass that token or
credential responses to the renderer. The host owns token generation and broker
lifetime. Storage failures return a generic error without credential logging.
`LocalCredentialBrokerInstrumentedTest` exercises the TCP contract on Android;
the same contract has a `main` entrypoint for JDK 21 with `org.json` on the classpath.
Consumers should additionally test their real encrypted-store adapter and restart
lifecycle. This transport does not authenticate a Cloud account by itself.
The private `native-host/local-credential-client.mjs` exports primary and pending
store clients (`createLocalCredentialStore`, `createLocalPendingCredentialStore`)
using the same bounded, non-redirecting, non-retrying loopback transport. Pending
operations address only the separate enrollment journal; the host retains token,
encrypted-store identity and revocation policy.

`LocalRuntimeHttp` supplies bounded JSON HTTP exchange with an absolute socket
deadline and injected monotonic clock. It only connects to loopback; the host
must authorize its route and provide its private token and response-size limit.
It deliberately contains no product route catalog. A second `exchange` overload
takes up to eight host-chosen request headers, for example a correlation ID
(`EmbeddedRuntimeService.exchangeHttp` has the same overload). A name must be
letters, digits or hyphens; a value must be 1-512 printable ASCII characters.
The transport's own headers (`Host`, `Authorization`, `Content-Type`,
`Content-Length`, `Connection`, `Transfer-Encoding`) cannot be replaced, and a
rejected header fails before any connection. The instrumented contract
also covers this client with real fixed-length, chunked, close-delimited,
oversized, truncated and delayed responses, and with accepted and rejected
request headers.

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
checks malformed/stale/inconsistent evidence, and
`NativeHealthServiceContract.assertRefusesSameSigner` requires a host's declared
service to refuse its own same-signer app UID, which is not the supervisor. Hosts
must separately qualify actual IPC, process death and observation providers in
their packaged applications.

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
not authentication success. `ResponseMode.FRAGMENT` admits `response_mode=fragment`
returns, with the response in the fragment or an error in the query, never both.
`OAuthBrowserLauncher` opens the authorize address in an Auth Tab when the browser
supports it and hands the result to the callback. If the browser cannot verify the
redirect host, or has no Auth Tab support, it opens a Custom Tab; the host then
delivers the App Link intent to the same callback. Portable JVM coverage is in
`test:native-host`; Android intent/app-link delivery, Auth Tab results and provider
callback registration need host qualification.

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
this does not load native code or authorize a library. `requireAbi` checks the
loader, bun and its libraries against an ABI that the caller supplies; it reads
ELF headers only and does not verify contents. Portable and Android tests use
synthetic files to verify install-path changes, optional-library cleanup and ABI refusal.

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

`EmbeddedRuntimeLaunch` constructs Android embedded agent/gateway/script commands and
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

For that instrumentation, `NativeRuntimeSession.injectChildExit(name)` ends one
named child of the running launch as a crash would. The supervisor's own exit
detection and restart budget then run. It sends no request and never ends a
child of a retired launch. `EmbeddedRuntimeService.injectChildExitFor(type, name)`
exposes it to a host only when the live service overrides
`allowsChildExitInjection()` to return true. Return true only in a test build;
the default is false, and the static method then throws.

Hosts that capture an endpoint before request admission must use the snapshot-bound
`NativeRuntimeSession.request(snapshot, ...)` overload. Capture the snapshot before
selecting the endpoint; a lifecycle change then rejects transport admission instead
of allowing a stale endpoint to inherit a newer running epoch.

The runtime inventory stager accepts `targetAbi: "x86_64"`; omission retains
ARM64. It requires the selected loader and rejects mixed ARM64/x86_64 loaders.
The Java extractor admits exactly one supported loader in the authenticated
inventory. `EmbeddedRuntimeLaunch` chooses that loader from the APK's verified
ABI-specific native directory, and rejects an ambiguous or missing loader. The
same private extraction, restart and environment isolation paths apply to both
architectures. A multi-ABI APK needs separately selected inventories; one shared
inventory must not mix native hashes from different architectures.

Task data-key access is an optional, native-only `LocalCredentialBroker` extension.
The existing constructor disables it. Hosts may supply a `TaskKeyCustody` port
bound to one native-selected account and database, plus an ownership guard. The
wire accepts no account ID or path. The broker serializes each key operation on
the guard and checks it before access and before returning material. Hosts must
serialize owner changes on that same guard, bind it to the runtime launch, and
close the broker when the launch retires. Retain the database writer lease;
`createForNewDatabase` is only for new files or migration destinations. Missing
keys for existing databases must fail, never trigger creation. An interrupted
mutation may have committed even if its response is refused or lost; do not
blindly retry destructive operations.

`createLocalTaskDataKeyStore` is the private native-process client. It validates
versioned key material and returns `{id, bytes}`; erase the byte array after use.
It shares the existing loopback bearer transport and redacted errors. Neither the
port nor its token or keys may enter a renderer, model, logs, or evidence. A host
must implement the port using encrypted native custody such as `TaskDataKeyStore`;
this extension does not select an adapter or enable encryption. The stable Cloud
owner identity and its lifecycle mapping remain host integration work: do not
substitute a rotating credential fingerprint. Database driver, WAL verification,
migration, and full account deletion remain separate requirements.

The optional `VerifiedAccountStore` broker port and
`createLocalVerifiedAccountStore` client transfer opaque whole-record snapshots
between trusted native processes. Bind an adapter to the encrypted
`VerifiedAccountCredentialStore` and one native launch/account guard. Serialize
owner transitions on that guard; the adapter must use the same owner mutex and
check its guard at the actual encrypted storage operation. Old constructors keep
this port disabled. In verified mode legacy primary `read` projects the credential;
legacy `write` and `clear` refuse. Use whole-record compare-and-exchange for changes.
No renderer receives this port or its token. An uncertain acknowledgement requires
an explicit snapshot read; the client never retries a mutation.

A host can pass a native `readVerifiedAccount` reader to `createCredentialGate`.
The reader returns the authenticated record, never a renderer-selected owner.
The gate retains the credential fingerprint session fence and derives its stable
owner from the JSON tuple `[authority, userId, organizationId]`. This option changes
storage ownership semantics: enable only with an explicit migration and database
writer lease. These ports do not implement either one or enable product encryption.

`NativeProviderAdmission` shares the native Cloud provider rules, protected binding
identity, credential expiry, generation checks and compare-exchange rollback.
Hosts keep encrypted storage, its mutation lock, the authenticated identity lookup
and lifecycle retirement. This class does not admit a legacy key on startup or
select an account. The native host test lane runs the existing provider contract
with JDK 21 and `ELIZA_JSON_JAR`, or the pinned `org.json:json:20250517` Gradle cache.
The compatibility host keeps its storage slot and subclass name; records do not
move or change shape. The later native profile overrides Cloud embeddings with
the admitted local BGE route; this extraction preserves the existing generic
provider behavior.

`CredentialMutationConductor` shares the resident credential commit boundary. It
reserves a stop request before dispatch, waits without holding the vault lock,
and commits only after that exact request has confirmed process absence.
`CredentialShutdownLease` keeps startup fenced between acknowledgement and the
credential commit. Pre-commit cancellation or timeout records abandonment and
releases only after the eventual stop acknowledgement; uncertain writes stay
fenced. Superseded owners can retire only their own request and cannot clear a
newer mutation's lifecycle state. The native sign-in outcome carries request and
credential identity when the renderer supplies a request ID, while preserving
the existing response shape for older renderers.

### First-party connection transport and resident lifecycle

`connection/` holds the pure policies a first-party renderer transport plugin
shares across products. `OwnerRoutePolicy` interprets a product's declarative
owner-route table (path prefixes, `{id}` segments, method and query-key sets);
it refuses unsafe characters, malformed escapes, dot segments, repeated slashes,
duplicate query keys and oversized paths before any route is consulted.
`CloudConnectionPolicy` is the reviewed Eliza Cloud API route set with the
product's deployment hosts injected: a flag-off build reaches only the
production API origin, and opens only the production web/services hosts and the
declared external providers. `ConnectionTransport` bounds URLs, JSON, bodies,
header values and Retry-After; `DelegationCallback` admits a product's Cloud
delegation return link; `SecureSlotPolicy` keeps native-owned slot namespaces
out of renderer storage and limits compare-and-exchange to declared draft
slots; `PendingRequests` is the cancel/browser-handoff state machine.

`NativeOwnerTransport` shares native owner enrollment, real identity/session
readback and bearer redaction. Hosts retain their existing cache, lifecycle lock
and HTTP transport. `NativeAppReadPolicy` admits the exact common AppProvider
GET routes through `OwnerRoutePolicy`. `NativeAppRequestPolicy` adds only the
first-run, config, character and stream-settings methods used by the shared
application, with a 10 MiB UTF-8 body limit. Server schemas and domain approvals
still decide each effect. First-run preserves the client's bounded, printable
idempotency header; duplicate header names and control characters are rejected. The
requirements probe does not enroll an owner. Authenticated requests use the native
owner bearer and reject a supplied stale owner identity before dispatch. Host
lifecycle checks fence late responses, and a 401 invalidates only the session
that made that request. The service closes owner requests before stop/restart and
only its current sequenced start may reopen them; Activity recreation does not
replace that owner. This is request admission, not runtime-health proof. Invalid
common aliases, invalid bodies and streaming requests cannot use the legacy fallback.
Canonical routes outside this set still use the existing
generic transport; Alpha retains its explicit domain effect policy and pending-call
checks through enrollment and dispatch.

`runtime/CredentialIntentFence` is last-intent-wins fencing over credential
writes. `runtime/NativeProviderSlot` binds a direct provider key (test-mocks
builds only) with compare-and-exchange readback, clears the slot with readback,
and composes the launch environment in one order: provider admission (or an
unbound launch), then the native runtime profile's embedding route, so a native
profile bound to Eliza Cloud keeps on-device BGE embeddings.
`runtime/ResidentAttachment` decides whether a surface may attach to the running
resident, including the no-provider generation. Products supply hosts, slot
namespaces, the plugin name and the packaged route table; `test:native-host`
runs the host-JVM contracts in `test/connection`.

`connection/WorkspaceAppReturn` and `WorkspaceAppReturnFlow` share exact HTTPS
callback parsing and the single-use, ten-minute native return journal. Hosts
supply their callback, protected pending slot, credential readback and atomic
compare-and-exchange. The journal uses `NativeProviderAdmission` credential
identity, including its UUID and expiry validation, without saving the token.
Hosts retain account verification, lifecycle locks and Android App Link admission.
