# `@elizaos/agent`

Standalone elizaOS agent and HTTP backend. Plugin routes can be registered on `AgentRuntime` and are served by the agent’s HTTP stack.

## Documentation

- **Paid HTTP routes (webhooks, plugins):** see the docs site section on [webhooks and routes](https://docs.elizaos.ai/plugins/webhooks-and-routes).
- **x402 micropayments on plugin routes:** configured through the runtime's `x402` config block and the `X402_API_KEY` environment variable (see `packages/agent/src/runtime/eliza.ts`).

## Local development

From this package:

```bash
bun install
bun run typecheck
bun run test
```

See `package.json` for `build`, `lint`, and other scripts.

## Manifest-v3 quarantine materialization

`createAgentBackupRestoreV3ProcessMaterializer` implements the durable restore
coordinator's record, component and assembly effects in private one-shot Agent
processes. It requires an existing isolated `CandidateFs` authority and retains
the exact root device/inode identities. It does not boot a runtime, register
plugins, open a listener, authorize a generation commit, or publish routes.

The worker receives bounded metadata and raw record bytes in one length-delimited
frame on stdin (private transport version 2). Stdin must stay open after that
frame: EOF or additional bytes cancel the operation. No inherited fd 3 is needed.
Only the digest of the completed canonical receipt is returned. Cancellation
closes stdin and waits for worker settlement, including nested database
validation, before the adapter returns.
Credentials and process preload options are not inherited. This is a trusted
local-process transport, not an authenticated remote Docker endpoint; its
caller must exclusively own both the transport and the quarantined roots.
Production filesystem authority requires Linux. Non-Linux pathname emulation
is explicitly test-only and makes no cross-process kernel-lock claim.

The opt-in `agent-backup-restore-v3-materializer-docker.test.ts` suite exercises
the built worker through real `docker exec -i` in a networkless Linux container,
including database-validator cancellation and exact retry. Build this package
first and preload `node:24.15.0-alpine`, then run the suite with
`AGENT_RESTORE_V3_DOCKER_TESTS=1`. When using a named Docker context, explicitly
set `DOCKER_CONFIG` to its configuration directory: Vitest isolates the home
directory. The harness creates only test-owned containers and tmpfs data and
removes them after each test; it never pulls an image implicitly. Its idle
container is a test fixture, not the production quarantine bootstrap.

`prepareAgentBackupRestoreV3Generation` copies an assembled candidate into a
second, non-overlapping private quarantine. It preserves the character and
physical database separately and composes state files, media and vault files
under `generation/state`. Copies use bounded descriptor-bound reads, independent
destination inodes and the existing no-replace file writer. Both root locks stay
held through source revalidation and durable prepared-layout publication.
Cross-component path collisions, source changes and unexpected destination files
fail closed. Exact replay checks the recorded destination tree without repairing
or rewriting a previously prepared generation.

The prepared-layout receipt is not a generation activation or boot grant. Both
roots remain unavailable to a running workload. Production integration must still
select the committed database and character explicitly, verify Agent
readiness/functionality, and gate activation and routes. Opening the prepared
directory directly with a live runtime would violate the quarantine contract.

`commitAgentBackupRestoreV3Generation` performs the local filesystem handoff. It
requires the exact prepared receipt and an existing, same-filesystem private
runtime parent outside the quarantine roots. That parent must remain exclusively
controller-owned and inaccessible to workloads/non-cooperating writers; the
runtime receives only its committed generation. The destination name is derived
from the prepared receipt, including the candidate's inode authority.

Under the candidate lock, commit validates the full tree and journals an immutable
intent before renaming it. It revalidates the moved tree and fsyncs both parents
before publishing the committed receipt. A crash between rename and receipt is
reconciled without copying. Terminal replay verifies the retained authority and
directory identity only: it must not rehash or overwrite a database that has
already accepted new runtime writes. Replacement directories fail closed.

This is not the coordinator's PRIMARY commit, a boot grant or a running Agent.
The production bootstrap and exact coordinator transport still need to consume
the local receipt, enforce the parent/workload isolation and explicitly select
the committed paths before boot. No restore feature is enabled by these helpers.

The explicit `startEliza({ restoredGeneration, configOverride, ... })` path
consumes `AgentBackupRestoreV3RuntimeGeneration.open(...)`, which verifies an
already committed receipt without completing an unfinished promotion. Its owner
must use a dedicated process, select the committed `ELIZA_STATE_DIR`, supply an
explicit non-interactive host config, and close the authority only after the host
and all of its runtime replacements have stopped. The journal and runtime parent
remain controller-private.

This path rejects missing physical database files, replaced directories,
conflicting database/state/agent identities and destructive migration settings.
It uses the validated committed character instead of the ordinary environment,
config-preset or canonical-file character override. The database is checked again
before SQL registration and runtime initialization. Normal startup is unchanged
when no explicit authority is provided. The integration test initializes the
real runtime and SQL adapter, reads the retained fact, writes another fact and
restarts without losing either. It deliberately stops before host attachment:
this does not prove server readiness, a signed probe, provider execution,
container restart integration or a functional restored reply.

Server-owned runtime replacements retain the committed authority and the explicit
host config. They stop the previous runtime before opening the same physical
database; a closed or invalid authority fails instead of selecting ordinary boot.
The API host marks a failed mandatory-disposal replacement unavailable and drops
the disposed runtime reference, so a later start cannot revive it by changing
only its reported status. Real HTTP tests cover rejected and throwing restarts;
the runtime/server wiring test substitutes the HTTP host boundary explicitly.
Restored server-only startup never self-registers or starts a routing heartbeat:
publication remains owned by the coordinator after its probe and funding gates.

## Research tasks

`ResearchTaskExecutor` requires a provider registered for
`ModelType.RESEARCH`. Provider absence, rejection, or an empty report returns an
unsuccessful `TaskResult` with a stable `errorCode`; it never falls back to
ordinary `TEXT_LARGE` synthesis and labels that output as research.

## Message-interaction session persistence

`FileMessageInteractionSessionStore` is the durable single-host adapter for
core's message-interaction session authority. It serializes independent local
processes, writes a 0600 regular file through same-filesystem fsync and atomic
rename, fails fast on corruption and symlinks, qualifies Linux lock owners by
boot/process generation, and generation-fences stale takeover and release with
an atomically published transition marker. A complete owner inode is fsynced
before no-replace hardlink publication; malformed owners have a bounded
recovery ceiling, while a live PID that cannot be generation-qualified fails
closed. An abandoned transition marker also fails closed because portable
filesystems cannot conditionally unlink a pathname generation; an operator may
remove it only after stopping every store user and verifying that no host
process owns the store. Operations report
`INTERACTION_STORE_RECOVERY_REQUIRED` and do not mutate state while that marker
remains; this state has no bounded automatic recovery. The marker path is
reported in `error.context.markerPath`; with the default filename it is
`<stateDirectory>/message-interaction-sessions.v1.json.lock.transition`.
Recovery requires stopping every process that uses the store, verifying that
none owns the adjacent `.lock` owner file, removing that exact `.transition`
path, fsyncing the state directory, and only then restarting store users. Its
boundary is one machine and one state directory. Multi-host deployments must
supply a transactional database implementation of
`MessageInteractionSessionStore` and use the session replay key as the effect or
outbox idempotency key.

Transition cleanup reports machine-distinct retry outcomes. A failure during
pre-operation stale recovery is
`INTERACTION_STORE_RECOVERY_CLEANUP_FAILED` with `committed: false`; a failure
after the durable transaction commit is
`INTERACTION_STORE_COMMITTED_CLEANUP_FAILED` with `committed: true`, so callers
must not retry the mutation. Every other release failure after the durable write
is `INTERACTION_STORE_COMMITTED_RELEASE_FAILED` with the same no-retry contract;
combined operation/release failures retain the release code and recovery
context. If publication sees a transition marker after linking its complete
owner, no transaction starts. Offline recovery must additionally verify the
reported owner token/inode, remove both the exact marker and owner paths, fsync
the parent directory, and restart. Owner-candidate cleanup failure is likewise
typed as pre-mutation (`INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED`,
`committed: false`) whether or not the candidate was published; a published
owner is safely detached when possible and `context.published` records which
case occurred.
After the state temp is renamed, a parent-directory sync failure reports
`INTERACTION_STORE_COMMIT_AMBIGUOUS` with `committed: "unknown"`; a close
failure after successful sync uses the same code with `committed: true`.
Both are non-retryable and require reading the reported state file to reconcile
the persisted session outcome. If lock unlink and transition cleanup both fail,
the committed cleanup error retains the unlink cause, cleanup error, marker,
lock identity/token, and exact offline recovery authority.

The file authority durably commits an effect before dispatch. If the process
dies after that commit but before retaining the receipt, the session remains
`committed` for operator reconciliation; it is never lease-transferred,
automatically retried, or revoked as if cancellation succeeded. The store lists
ambiguous commits and accepts only a verified receipt to reconcile them without
re-execution. Completed receipts are retained for seven days and unreconciled
commits for thirty days by default, after which bounded collection prevents
permanent capacity exhaustion.

The bundled `eliza` plugin registers `MessageInteractionHostService` as the one
runtime authority connectors resolve through `MESSAGE_INTERACTION_HOST_SERVICE`.
Connectors submit capability profiles and trusted render bindings to `prepare`,
then send authenticated inbound provider receipts to `consume`. Only host-owned
effect handlers execute retained operations; completed receipts preserve the
provider event, canonical inbound event, audit id, and app-state proof for replay.

## Approval-bound plugin installation

`installPlugin` always installs the canonical npm package declared by the
registry (`plugin.npm.package`), even when lookup used a display name or alias.
Existing callers may continue passing a version string as the third argument.
Security-sensitive callers can instead bind the package and exact version they
showed an operator for approval:

```ts
const result = await installPlugin("friendly-registry-alias", undefined, {
  expected: {
    packageName: "@vendor/canonical-plugin",
    version: "2.4.1",
  },
});
```

The installer rejects a changed package or version before creating the install
directory or executing a package manager. A bound install uses that exact npm
package/version and does not silently fall back to a local workspace or moving
Git branch. Successful results include `provenance` identifying the actual
`local`, `npm`, or `git` source. npm/Bun lock integrity and resolved tarball
metadata are returned when available; unavailable integrity stays `null`, and
Git installs report the cloned commit.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.
