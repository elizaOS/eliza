# @elizaos/host

Shared host configuration, boot aliases and HTTP plugin lifecycle. Hosts install
route lifecycle explicitly and own authentication, storage and model composition.

Use `@elizaos/host` for Node HTTP helpers, build variants and native library
policy; use `@elizaos/host/protocol` for browser-safe contracts, platform detection
and configuration. `@elizaos/host/native-host` exposes
Node-only SQLite task gateways, research collection and trace transport, database
leases, and verified document-runtime packaging. Consumers supply authentication,
consent, measurement policy and lifecycle ownership. Internal code imports defining files.

From the repository root, run `bun run --cwd packages/host build`,
`bun run --cwd packages/host test` and `bun run --cwd packages/host typecheck`.

## Native hosts

Consumer hosts can use `@elizaos/host/native-host` for authenticated
SQLite task lifecycles and explicit domain-route extensions. Document/canvas
bundling and verified Android packaging live in `native-host/build-document-runtime.mjs`
and `native-host/android-documents.mjs`; consumers supply reviewed source identity,
canvas version and locked package records. Staging and verification accept
`targetAbi: "arm64-v8a"` (the default) or `"x86_64"`. Each build admits only the
selected canvas package, native path and ELF architecture; mixed ABI document
libraries are refused. Packaging checks do not prove Android canvas execution.
App runtime integrations run with `bun run --cwd packages/app test:consumer-host`.
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
consent and current-owner fences; importing it starts no collection. From the
repository root, run `bun run --cwd packages/host test:native-host` for real
SQLite/HTTP evidence, including stop during an unanswered request. These modules
do not authorize enrolling real participants.

`native-host/research-configuration.mjs` owns private research configuration
initialization and offline key rotation. Hosts supply retention, capacity,
operator identity and the existing measurement-policy store factory. Rotation
uses the canonical database lease and retains previous/next recovery files before
changing encrypted SQLite records; it refuses to overwrite prior recovery files.
The helper never enrolls participants or returns plaintext operator credentials.
After validating the new key against retained data and backups, the operator
must retire the private recovery files explicitly. Until then they retain old
key material and block another rotation; rotation alone does not remove it.

`@elizaos/host/native-host` supplies Wilson 95% binomial intervals and
deterministic nearest-rank percentile bootstrap intervals for a mean. Hosts own
sampling units, cohorts, confidence labels, resample/seed/work budgets and
interpretation; these calculations do not certify independence or causal effects.

`native-host/gateway-lifecycle.mjs` acquires configured helper, task gateway,
optional capture, reputation and HTTP server resources through explicit host
factories. It waits for listening before reporting readiness and rolls back
acquired resources on startup or bind failure. Shutdown attempts every release
in reverse order, collects errors, and returns the same completion promise to
concurrent callers. The consumer retains configuration, credentials, route
policy, names and diagnostics; factories must clean up partial acquisitions if
they fail before returning a resource. Real HTTP/file lifecycle regressions run
in `test:native-host`.

`native-host/gateway-bootstrap.mjs` assembles a local or native gateway from
explicit configuration and host factories. It reads selected token/binding files,
chooses the file store or native credential broker, prepares desktop task runtime,
and hands resources to the shared gateway lifecycle. It does not read environment
variables or choose product identities. Native admission validates the private
inbound token, broker endpoint and gateway port before acquiring helpers. A
desktop host sets `requireInboundToken: true` to require the same inbound token.

`@elizaos/host/voice/*` contains the reusable realtime voice transport, Cartesia
Ink/Sonic adapters, Fish adapter, and canonical conversation SSE bridge. Hosts
must inject token verification, owner/session authorization, conversation scope,
revocation and usage storage; importing these modules grants no authority or
opens provider connections. Cloud retains its JWT and durable Redis policies.

Task gateways accept a trusted host `databaseProvider` with `open({path})` and
`assertEncryption({db,path})`. `requireEncryptedDatabase: true` refuses startup
unless the provider explicitly verifies the open connection before the gateway
writes task schemas or records. It never silently opens ordinary SQLite as a
fallback. Providers must close partially opened resources when `open` throws;
the gateway closes a returned connection when admission fails. Provider error
bodies and key details are not returned. The default remains legacy ordinary
SQLite for existing consumers; this admission contract is not an encryption
implementation or a readiness claim.

Encrypted deployments still need the reviewed SQLCipher/other compatible driver
and packaged native libraries, a dedicated per-account data-key slot wrapped by
native secure-store custody, active-key/WAL verification, and separate encryption
for outcome journals/evidence/diagnostics. Migration must stop writers, preserve
source and all sidecars, copy to a new destination, validate task/outcome counts
and recovery records, then durably switch an explicit manifest. Never automatically
delete the source or overwrite a recovery copy. Test interruption at every phase,
wrong/lost key, new-account admission and revocation before enabling that profile.
This API does not perform migration, deletion, key export or renderer admission.

The opt-in `createSqlCipherTaskProvider` candidate implements that provider using
an explicitly admitted N-API SQLCipher artifact and host-owned key callback.
See [its build and qualification contract](native-host/task-sqlcipher/README.md).
It has no automatic APK staging, account authorization, migration or fallback;
source availability alone does not qualify encrypted storage on a consumer device.

### Optional Android verified task custody

`native-host/android/ai/eliza/host/VerifiedTaskCustody.java` is an explicit native
host source input. A consumer must select it alongside native-agent runtime and
secure-store native-only sources. No default Gradle dependency or renderer API
is added. The host supplies its existing dedicated verified-account directory
and Keystore alias, a separate task-key directory/alias, and an existing private
0700 no-backup database directory. Resolve the trusted Android Context path with
`getCanonicalFile()` before supplying that root; Android data-directory aliases
are not accepted as canonical paths. All account writes must use this composition
in the one native host process; it does not provide cross-process credential CAS.

Create the adapter inside `NativeRuntimeSession`'s launcher. Its account port and
bound database port use the same `guard()` in `LocalCredentialBroker`.
`openBroker` registers broker closure with the launch scope; a null database
permits verified enrollment with task-key access disabled.
`bindDatabase` takes a native-selected logical name. The owner directory uses
the existing gateway's authenticated authority/user/organization tuple hash;
credential rotation preserves that directory but retires old database ports.
Never supply decoded token claims, renderer identities, or paths from the wire.

The actual SQLCipher writer must acquire its native lease before requesting a
key. Read refuses a missing key when any database, WAL, SHM, or rollback journal
entry exists, even an empty file or dangling symlink. Create and generation-bound
remove require all those entries to be absent. A durable key left by an
interrupted first open can be reused; existing data is never treated as new.
This adapter creates no database and performs no migration or automatic cleanup.

A broker cannot revoke a key already held by Bun. The host must bind the writer's
session/credential guard and retire the supervised writer on owner change before
admitting replacement work. `Database.check()` fences native admission against
the exact captured encrypted account snapshot. It is not a synchronous remote
replacement for the provider's `checkOwner`. Hosts must finish that lifecycle
wiring and qualify the actual Android SQLCipher library before enabling storage.
Returned key JSON is confined to the private native process channel; byte-array
copies are wiped, but immutable Java JSON/base64 strings are not fully erased.
The instrumentation cases in `native-host/android-test` exercise real Keystore
storage, TCP broker requests, account changes, and database recovery refusals.

`native-host/sensitive-text.mjs` provides a session-scoped secret scrubber and
sensitive-text gate. Hosts supply optional matchers and clear memory only when
the session ends. Capacity exhaustion refuses new values instead of forgetting
earlier ones. Object nesting beyond the supported depth is refused rather than
returned unscrubbed. Detection is conservative, not a guarantee that every
secret is recognized.
