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
  (`auto` | `manual` | `pre-shutdown` | `pre-upgrade`). The `pre-upgrade` type
  is the restore point `executeDowngrade` replays on rollback (#9964).
- **Restore:** reuse `getReconstructedBackupState()` for chain replay and the
  bridge `/api/restore` push.
- **Rollback:** `executeUpgrade` refuses to swap without a manifest-bearing
  `pre-upgrade` backup. `executeDowngrade` provisions blue on
  `previous_image_digest`, pushes the reconstructed `pre-upgrade` state before
  cutover, and fails loudly if the restore point is missing or rejected. The
  operator route enqueues `agent_downgrade` daemon jobs; it never runs
  automatically.

## Operational proof

The code path is tested for local manifest backup/restore, corrupt backup
refusal, encrypted local file restore, cloud diff safety, encrypted backup row
storage, metadata-only backup listing, pre-upgrade blocking, rollback restore,
and daemon rollback job execution.

Full PR evidence still requires a live staging run: backup -> wipe -> restore,
plus upgrade -> rollback, with real agent logs, DB/media artifacts,
screenshots/video, and a live LLM trajectory per `AGENTS.md`.

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
