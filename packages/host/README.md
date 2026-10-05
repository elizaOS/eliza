# @elizaos/host

Shared host configuration, boot aliases and HTTP plugin lifecycle. Hosts install
route lifecycle explicitly and own authentication, storage and model composition.

Use `@elizaos/host` for Node HTTP helpers and `@elizaos/host/protocol` for
browser-safe contracts and configuration. `@elizaos/host/native-host` exposes
Node-only SQLite task gateways, research collection and trace transport, database
leases, and verified document-runtime packaging. Consumers supply authentication,
consent, measurement policy and lifecycle ownership. Internal code imports defining files.

From the repository root, run `bun run --cwd packages/host build`,
`bun run --cwd packages/host test` and `bun run --cwd packages/host typecheck`.

## Native hosts

Consumer hosts can use `@elizaos/host/native-host` for authenticated
SQLite task lifecycles and explicit domain-route extensions. Document/canvas
bundling and verified ARM64 packaging live in `native-host/build-document-runtime.mjs`
and `native-host/android-documents.mjs`; consumers supply reviewed source identity,
canvas version and locked package records. App runtime integrations run with `bun run --cwd packages/app test:consumer-host`.
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
consent and current-owner fences; importing it starts no collection. Run `bun run test:native-host` for real SQLite/HTTP evidence, including stop during an
unanswered request. These modules do not authorize enrolling real participants.

`native-host/research-configuration.mjs` owns private research configuration
initialization and offline key rotation. Hosts supply retention, capacity,
operator identity and the existing measurement-policy store factory. Rotation
uses the canonical database lease and retains previous/next recovery files before
changing encrypted SQLite records; it refuses to overwrite prior recovery files.
The helper never enrolls participants or returns plaintext operator credentials.
After validating the new key against retained data and backups, the operator
must retire the private recovery files explicitly. Until then they retain old
key material and block another rotation; rotation alone does not remove it.

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
inbound token, broker endpoint and gateway port before acquiring helpers.
