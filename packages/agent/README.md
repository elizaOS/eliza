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

## Core relationships migration verification

`migrateCoreRelationshipsToKnowledgeGraph` is the explicit, non-destructive
operator boundary for inventorying the old Core `RelationshipsService`
persistence for one agent. Run it with a `CoreRelationshipsMigrationDatabase` whose
transaction callback owns one PostgreSQL-compatible session; the API does not
accept a free statement executor that could drift across pooled connections.
The migration locks the source tables before its serializable snapshot, inventories
and archives the complete source rows, preserves the agent entity as the
canonical `self` node, projects contacts, identities, typed edges, cadence,
interactions, retirement state, audit receipts, and merge lineage, then reads
back every source-to-target receipt.

This is an operator-only maintenance operation. Its `SHARE ROW EXCLUSIVE` locks
block normal writes to the legacy source tables for the duration of the copy, so
run it only inside an explicit global maintenance window; it is not safe as an
online tenant-by-tenant job while uncooperative source writers are active.

Every successful run stops at `verified`; it does not alter source authority,
reroute callers, install write fences, or delete source rows. Migration-owned
entities and embedded identities carry deterministic provenance so a replay can
apply source renames and removals without overwriting unrelated canonical data.
A target collision, disappeared source record, ambiguous active edge, unreadable
row, or failed readback rolls the transaction back and refuses verification.

Changing production caller authority requires a separate design that coordinates
all writers. This verification API intentionally does not provide or imply that
capability.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.
