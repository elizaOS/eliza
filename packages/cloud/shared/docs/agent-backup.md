# Agent backup — real state surface

> Status: **implemented contract.** The agent server now exposes
> `/api/snapshot` and `/api/restore` backed by a full-agent manifest covering
> database, media, vault ciphertext, character config, and remaining state-dir
> files. Cloud backup rows store that manifest as a KMS-encrypted full backup
> (R2/offloaded when heavy-payload storage is configured), and `pre-upgrade`
> snapshots are mandatory before fleet swaps so rollback can replay the restore
> point. Issues #9963 and #9964.

## Why this exists

The legacy snapshot payload was a 3-field toy:

```ts
interface AgentBackupStateData {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
}
```

`AgentBackupStateData` remains backward-compatible with those fields, but a
real backup now carries `manifest?: AgentBackupManifest`
([`src/db/schemas/agent-sandboxes.ts`](../src/db/schemas/agent-sandboxes.ts)).
The deployed agent server produces the manifest in
[`packages/agent/src/services/agent-backup.ts`](../../../../packages/agent/src/services/agent-backup.ts)
and serves it from
[`packages/agent/src/api/server.ts`](../../../../packages/agent/src/api/server.ts).
Cloud still recognizes `SNAPSHOT_ENDPOINT_UNSUPPORTED` for old images during
scheduled auto snapshots, but `pre-upgrade` snapshots must contain a manifest or
the upgrade is refused.

## The real state surface a backup MUST cover

A faithful backup is a manifest of components, each with its own integrity hash,
so a partial/corrupt restore is detectable and **fails loudly** rather than
booting a half-restored agent.

| Component | Captured by | Notes |
| --- | --- | --- |
| **Database** | PGlite filesystem snapshot (`PGLITE_DATA_DIR`, default `.eliza/.elizadb`) or external Postgres logical table rows selected by agent ownership. | Restore replaces the PGlite dir after closing the adapter, or deletes/reinserts agent-owned Postgres rows in a transaction. |
| **Content-addressed media** | `${STATE_DIR}/media/<sha256>.<ext>` | Restore verifies every file byte hash and replaces the media root, avoiding stale attachments. |
| **Vault / secrets** | `vault.json`, `.vault-pglite/**`, `audit/vault.jsonl` | Backed up as stored bytes/ciphertext only. Restore prunes stale vault files and never decrypts secrets. |
| **Character + remaining state-dir** | Runtime character, config file, and non-log state-dir files excluding media/backups/vault/database-owned dirs. | Restore verifies hashes, rewrites the config file, prunes stale scoped state files, and returns `requiresRestart: true`. |

### Per-component integrity hashes

The manifest stores a sha256 per component and per file. Restore recomputes the
file-set, Postgres dump, and manifest component hashes before applying; **a
mismatch aborts restore**. Cloud backup rows still store `content_hash`, and
`agent-backup-diff` now forces manifest-bearing snapshots to remain full backups
so the legacy incremental delta format cannot drop component blobs.

## Storage target — dual: local file + cloud R2

The backup lands through the existing backup row and heavy-payload storage path:

1. **Agent/local runtime** — `/api/snapshot` returns the full manifest payload;
   `/api/restore` applies it to the agent's configured state/database locations.
2. **Cloud backup rows** — `prepareAgentBackupInsertData` encrypts
   `agent_sandbox_backups.state_data` with the existing org-scoped KMS field
   crypto before storage. Large encrypted payloads then flow through
   `offloadJsonField` to R2/S3-compatible object storage when configured,
   leaving an inline empty preview and a `state_data_key`. Repository reads
   decrypt at the hydration boundary, so restore callers never handle
   ciphertext directly.

## Relationship to existing primitives (reuse, do NOT duplicate)

- **Backup rows:** reuse the `agent_sandbox_backups` table and the
  `agent-backup-diff` full/incremental delta engine
  ([`src/lib/services/agent-backup-diff.ts`](../src/lib/services/agent-backup-diff.ts)).
  Do NOT add a second backup table or a parallel snapshot store.
- **Snapshot types:** the real manifest still flows through `snapshot_type`
  (`auto` | `manual` | `pre-shutdown` | `pre-upgrade` | `pre-delete`). The
  `pre-upgrade` type is the restore point `executeDowngrade` replays on rollback
  (#9964); `pre-delete` is the final recovery point described below.
- **Restore:** reuse `getReconstructedBackupState()` for chain replay and the
  bridge `/api/restore` push.
- **Rollback:** `executeUpgrade` refuses to swap without a manifest-bearing
  `pre-upgrade` backup. `executeDowngrade` provisions blue on
  `previous_image_digest`, pushes the reconstructed `pre-upgrade` state before
  cutover, and fails loudly if the restore point is missing or rejected. The
  operator route enqueues `agent_downgrade` daemon jobs; it never runs
  automatically.

## Manifest-v3 catalogue capture and publication

The manifest-v3 catalogue lane is additive and fail-closed. Existing sandbox
rows migrate with no activation authority, so they are ineligible for periodic
capture until a later control-plane release publishes the complete immutable
activation and vault authorities. This release does not infer those values from
mutable container names, current node placement, or process environment.

An eligible capture is bound to the exact organization, agent, activation
generation, lifecycle revision, source node record and boot incarnation,
immutable Docker container ID, and image digest. Robot sources additionally
require an operator-pinned SSH host key; changing or losing that pin atomically
revokes the node incarnation until the new boot is attested. Cloud sources bind
the Hetzner server identity. Reservation locks the source while it records this
authority, so lifecycle changes cannot race a stale capture. The full-only gate
described below prevents this release from traversing or advertising an
incremental chain.

The Agent `/api/snapshot/v2` producer emits bounded authenticated frames. Cloud
parses and encrypts those frames into a durable, bounded manifest-v3 spool.
PGlite 0.4.x is a documented exception inside the producer: its official dump
API materializes the file list, tar, gzip buffers, and Blob before framing can
begin. This release therefore takes the physical-size preflight and dump under
PGlite's exclusive query/transaction fence and the adapter lifecycle fence,
accepts at most 40 MiB of logical database files, and estimates archive size as
the 512-byte-rounded file sizes plus 4 KiB per entry and 1 MiB fixed overhead.
Before materialization, the process must have at least eight archive-sized
copies plus 32 MiB of emergency headroom available. The legacy JSON snapshot
path uses the same consumer-lifetime export lease and performs a second gate of
four compressed-Blob copies plus 32 MiB before array-buffer, base64, and JSON
conversion. Availability comes from the process-aware runtime metric with an OS
fallback; no low-baseline RSS assumption is made. A missing bounded exporter,
an unprovable physical directory, or a database above that limit fails before
the dump starts. There is no live-file fallback in capture v2. An uncancellable
late dump keeps the physical-directory lane busy until it settles, so a
disconnected client cannot start overlapping dumps.

Capture revalidates the execution lease and source authority, derives manifest
inventory, plugin-set, watermark, chain, operation key-bundle, and
vault-reference projections at the database boundary, and stops at a confirmed
`captured` state. A request deadline may change on replay; the operation,
source, manifest, and spool authorities may not.

This executable lane currently admits full snapshots only. Incremental
reservation and direct pipeline invocation fail before allocating catalogue,
KMS, network, or spool authority. The schema retains bounded parent/base chain
fields for the required follow-up, but the gate may be removed only with a real
delta producer, periodic full checkpoint, maximum chain depth, compaction, and
restore-chain proof; relabeling full component bytes as a delta is forbidden.

Publication then follows one replayable sequence for every encrypted chunk:

1. reserve the canonical tenant-scoped object key in the primary database;
2. durably mark provider-write intent;
3. revalidate the catalogue lease immediately before every bounded provider
   write attempt;
4. create the immutable Cloudflare R2 object and persist its exact generation,
   checksum, and receipt before marking it verified;
5. read that exact persisted primary generation into a bounded fresh buffer,
   verify it again, and create the independent Hetzner Object Storage copy;
6. transition to `protected` only when the secondary inventory exactly equals
   the authenticated primary manifest inventory.

This slice uses one bounded immutable provider PUT per encrypted chunk. It does
not yet implement provider-native multipart upload, upload-part replay, or
multipart abort receipts; those remain required before Goal 3 can be declared
complete.

Provider reads, writes, retries, and backoff share an absolute transfer
deadline and caller abort signal. Buffers holding ciphertext or key material are
zeroized after use. Garbage collection uses only durable locators and receipts;
ambiguous provider response loss is reconciled before deletion, and divergent
objects are quarantined instead of guessed away. A spool is removable only
after an exact current `protected`, `retained`, or `restore_verified` catalogue
proof covers every primary and secondary object.

### Dedicated periodic worker remains dormant

The database scheduler uses database time, preserves one operation ID across
response loss, admits at most one due operation per organization and source
node, and advances `next_backup_at` only after exact current manifest-v3 dual
protection. Retry backoff has a separate timestamp, so a failure never moves the
RPO deadline or hides an overdue agent.

`eliza-backup-catalog-worker.service` is a dedicated, serial caller of the
catalogue runtime. Its enabled composition binds one R2/Hetzner registry, one
Steward KMS operation-key-bundle provider, the exact database-backed capture
attestation, a persistent `/var/lib/eliza-backup-catalog/spool`, publication,
GC, and the protected/terminal spool janitor. `--once` runs one deterministic
cycle. The normal cadence and retry delay are bounded to 60 seconds, and
SIGTERM reaches capture and publication before systemd's bounded shutdown
fence. Health is published without locators or credentials at
`/run/eliza-backup-catalog/health.json`.

The runtime configuration exposes bounded schedule, operation, garbage-
collection, and deletion batch/lease/retry controls in
`packages/cloud/shared/.env.example`. Operation admission is deliberately
fixed to one claim per cycle until a durable cross-cycle tenant cursor proves
starvation freedom. Capture and object-transfer deadlines must each leave at
least 30 seconds inside `AGENT_BACKUP_OPERATION_LEASE_MS` for fenced catalogue
settlement. Operation and GC retry bases must not exceed their corresponding
retry maxima; invalid combinations fail before provider authority is built.

Both `AGENT_BACKUP_CATALOG_RUNTIME_ENABLED` and
`AGENT_BACKUP_RPO_SCHEDULER_ENABLED` are forced to `0` in the merge-time
systemd/deploy path. The disabled authority composition reads only those gates
and returns before importing or constructing database, provider, KMS, executor,
or spool authority. The outer daemon may additionally read non-secret cadence
and health controls needed to publish its dormant status; the dedicated dormant
file also pins an inert spool path. Before either gate can be activated, backup
authority must leave the shared host's provisioning-account sudo/docker trust
domain (or move to a dedicated host) and execute an integrity-protected
artifact; a root-owned copy on the current shared host alone is not an isolation
boundary. Enabled configuration is fail-closed: storage identities and
credentials, Steward KMS bearer, persistent spool bounds, legacy-writer drain
receipt, and deployment-pinned agent/database/plugin versions must all be
present before any provider is built. These static runtime metadata values are
required because the current activation receipt does not persist them; they are
never inferred from mutable process state.

This worker therefore makes no production 15-minute RPO claim at merge.
Activation/vault writers, coexistence fencing against legacy/manual producers,
and fleet-capacity evidence must land before the gates may be enabled. Missing
authority remains overdue and unroutable; it is never reported as protected.

## Operational proof

The code path is tested for local manifest backup/restore, corrupt backup
refusal, encrypted local file restore, cloud diff safety, encrypted backup row
storage, metadata-only backup listing, pre-upgrade blocking, rollback restore,
and daemon rollback job execution.

The manifest-v3 slice additionally exercises an opt-in synthetic 1 GiB framed
stream under a fixed RSS ceiling, a 128 MiB encrypted spool pipeline, a real
PGlite lifecycle-fenced dump/restore proof together with capture-level
preflight and memory-bound tests, primary and secondary response-loss replay,
lease loss, source/node ABA fencing, exact locator garbage collection,
divergent-object quarantine, migration replay, and database-clock scheduler
concurrency. The synthetic 1 GiB proof validates framing and backpressure, not
PGlite's materializing exporter. Supporting a real database above 40 MiB
requires a genuinely streaming, consistency-fenced exporter and a fleet-side
quota that prevents the database from crossing the supported limit. These are
local integration proofs, not a production RPO attestation.

Full PR evidence still requires a live staging run: backup -> wipe -> restore,
plus upgrade -> rollback, with real agent logs, DB/media artifacts,
screenshots/video, and a live LLM trajectory per `AGENTS.md`.

## Successful deletion recovery retention

A live dedicated agent is snapshotted before teardown. When its deletion
transaction succeeds, that transaction detaches only the exact `pre-delete`
row associated with the deletion attempt, then deletes the sandbox. The
existing `ON DELETE CASCADE` still removes every attached scheduled, manual,
shutdown, and upgrade backup. Unsupported legacy images that cannot snapshot
do not fabricate a recovery record. Instead, the deletion transaction records
a typed waiver bound to the exact deletion attempt, environment revision,
sandbox ID, and bridge URL. A retry may reuse only that same generation's
waiver; a changed generation must be captured again.

Rows that still carry a dedicated container locator but have entered an error
or disconnected state remain fail-closed when no bridge is reachable. A
deletion continuation known to have originated from an already-stopped,
uncounted row skips capture, so a retained historical sandbox ID cannot wedge
cleanup against a container that is already gone.

The detached row keeps explicit `recovery_organization_id`,
`recovery_agent_id`, and `recovery_deletion_attempt_id` fields because its
parent sandbox no longer exists. Recovery lookup requires both organization
and deleted-agent IDs and ignores expired rows, preventing a backup ID or agent
ID from crossing a tenant boundary. The payload remains encrypted with the
organization's KMS key and uses the same inline/R2 storage path as every other
agent backup.

Recovery records expire 30 days after the successful delete commits. The
provisioning worker removes expired rows in batches of at most 100 during its
infrastructure-maintenance sweep. For R2/S3-offloaded payloads it deletes the
object first and only then removes the database row; storage failure leaves the
row as a retryable cleanup handle. Deleting the organization cascades its
detached recovery rows immediately, while the object-store lifecycle policy
remains the final safeguard for any external bytes whose synchronous deletion
could not complete.

## Image upgrade ↔ rollback & DB-migration discipline (#9964)

Dedicated agents share **one** Postgres per environment (prod/staging) — there
is no per-agent DB branch. A fleet image upgrade is therefore a **shared-schema
change**: the new image's plugin-sql migrations run at container boot against
the DB that agents still on the *old* image are also using. `executeDowngrade`
rolls the **image** back (onto `previous_image_digest`, restoring the
`pre-upgrade` snapshot before cutover), but it **cannot roll a destructive
forward migration back** — a dropped column / retyped column / dropped table is
gone the moment the new image applied it, and the rolled-back old image then
reads a schema it no longer matches.

**Rule: agent-image migrations MUST be expand/contract (additive-only).**

- **Expand (the upgrade):** only add — new nullable columns, new tables, new
  indexes (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). The new
  image reads the old schema; the old image ignores the new objects. This keeps
  a mixed-version fleet (some agents up/down mid-rollout, capped at
  `MAX_INFLIGHT_UPGRADES`) correct, and keeps `executeDowngrade` a real restore
  point rather than a swap into a broken schema.
- **Contract (the cleanup):** a column drop / rename / type change is a
  **separate, later** migration, shipped only **after** the whole fleet is on
  the new image and no rollback to the pre-expand image is wanted. Never combine
  expand + contract in the image that a rollback might return from.
- **Never** put a destructive DDL in the same image version as the feature that
  needs it. If a value must change shape, expand (add the new column, backfill,
  dual-write), cut over reads in a later image, then contract.

This mirrors the repo-wide migration rule (`CLAUDE.md`: append-only,
`IF NOT EXISTS`/`IF EXISTS`, small targeted migrations) and makes it binding for
the agent-image upgrade path specifically, where a shared DB + a real rollback
path raise the stakes. A migrate-verify-on-boot gate that health-fails an
upgrade whose migrations did not apply cleanly is the next step, but is
daemon/image work (see "Out of scope" above).
