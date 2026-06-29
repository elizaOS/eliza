# Agent backup — real state surface (spec)

> Status: **specification / gap analysis.** This documents what a *real*
> full-agent backup must cover so a backup → wipe → restore round-trip across
> topologies is faithful. It is the contract the next backup-engine PR builds
> to. Issue #9963.

## Why this exists

Today's snapshot payload is a 3-field toy. `AgentBackupStateData`
([`src/db/schemas/agent-sandboxes.ts:207`](../src/db/schemas/agent-sandboxes.ts))
is:

```ts
interface AgentBackupStateData {
  memories: Array<{ role: string; text: string; timestamp: number }>;
  config: Record<string, unknown>;
  workspaceFiles: Record<string, string>;
}
```

It is produced by the cloud-agent template's demo `/api/snapshot` handler
([`packages/app-core/deploy/cloud-agent-shared.ts`](../../../app-core/deploy/cloud-agent-shared.ts),
the `/api/snapshot` + `/api/restore` block) and pulled by
`ElizaSandboxService.fetchSnapshotState`
([`src/lib/services/eliza-sandbox.ts:4771`](../src/lib/services/eliza-sandbox.ts)).
The deployed elizaOS V2 agent image does not even serve `/api/snapshot`, so a
real backup against it is a no-op today (the `SNAPSHOT_ENDPOINT_UNSUPPORTED`
sentinel). `memories` / `config` / `workspaceFiles` capture none of the durable
agent state below. A wipe-and-restore using this payload silently loses the
database, all media, and every secret.

## The real state surface a backup MUST cover

A faithful backup is a manifest of components, each with its own integrity hash,
so a partial/corrupt restore is detectable and **fails loudly** rather than
booting a half-restored agent.

| Component | Source of truth | Notes |
| --- | --- | --- |
| **Database** | plugin-sql PGlite dir (`resolvePgliteDir()`, [`plugins/plugin-sql/src/utils.ts:31`](../../../../plugins/plugin-sql/src/utils.ts)) **or** external `POSTGRES_URL` | Local agents store everything in the PGlite dir (memories, entities, relationships, rooms, tasks, embeddings). Back it up as a consistent snapshot of the data dir; for an external Postgres, take a logical dump (`pg_dump`), not a file copy. This — not the `memories` array — is the canonical conversation/memory store. |
| **Content-addressed media** | `${STATE_DIR}/media/<sha256>.<ext>` ([`packages/agent/src/api/media-store.ts:173`](../../../../packages/agent/src/api/media-store.ts), served at `/api/media/<sha256>.<ext>`) | The single attachment store. The sha256 filename IS the integrity hash — verify each file's bytes hash to its name on restore. The DB references media by URL; restoring the DB without these files yields dangling attachments. GC (`gcUnreferencedMedia`) runs on a grace window, so capture media and DB as one consistent point. |
| **Vault / secrets** | encrypted secret store (org encryption keys: [`src/db/schemas/organization-encryption-keys.ts`](../src/db/schemas/organization-encryption-keys.ts)) | API keys, wallet keys, connector tokens. **Back up the ciphertext only — never plaintext.** The decryption key is org-scoped and lives outside the per-agent backup; a backup must be restorable only by an actor who already holds that key. |
| **Character + remaining state-dir** | `agent_config` / character JSON + everything else under `${STATE_DIR}` | Character definition, plugin config, scheduled-task records, and any plugin-written state-dir files (logs excluded). |

### Per-component integrity hashes

The manifest stores a sha256 per component (the DB dump, the media set as a
whole or per file, the secrets blob, the character) plus a top-level manifest
hash. Restore verifies each hash before applying; **a mismatch aborts the whole
restore** — no silent partial restore, no "best-effort" merge. This mirrors the
existing `content_hash` integrity check already used for incremental backup
chain reconstruction in
[`src/db/repositories/agent-sandboxes.ts`](../src/db/repositories/agent-sandboxes.ts)
(`getReconstructedBackupState`).

## Storage target — dual: local file + cloud R2

The backup must land in two places, selectable per deployment:

1. **Local file** — a manifest + component blobs under the state dir, for
   local-only / desktop agents with no cloud.
2. **Cloud R2** — via the bound `BLOB` R2 bucket
   ([`src/types/cloud-worker-env.ts:19`](../src/types/cloud-worker-env.ts)),
   for managed-fleet agents.

The schema is already wired for the R2 leg but the columns are **currently
dead** — every backup row is written with `state_data_storage = 'inline'` and a
null `state_data_key`
([`src/db/schemas/agent-sandboxes.ts:226`](../src/db/schemas/agent-sandboxes.ts)).
The offload helpers exist (`ObjectStorageMode = "inline" | "r2"`,
`offloadJsonField` / `getObjectText` in
[`src/lib/storage/object-store.ts`](../src/lib/storage/object-store.ts)) and the
backup repository already calls them on the `state_data` jsonb, but for the
full-surface manifest the backup engine must set `state_data_storage = 'r2'` and
populate `state_data_key` with the R2 object key of the offloaded manifest.

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

## Out of scope for the current pass (next-PR steps)

These are explicitly deferred — the current PR only lands the schema/type/code
scaffolding and this spec:

1. **R2 offload wiring for the full manifest** — flip `state_data_storage='r2'`
   + populate `state_data_key` for the real backup engine (helpers exist; not
   yet called for the full surface).
2. **The full local backup engine** — DB dump/restore, media set capture +
   hash-verify, encrypted-secrets capture, character + state-dir, manifest
   assembly with per-component integrity hashes.
3. **Cross-topology backup → wipe → restore e2e** — requires an armed staging
   provisioning daemon + a real `@elizaos/agent` container image; cannot run in
   a unit context.
4. **Local LifeOps-scheduled backup** — schedule recurring backups via the
   existing LifeOps scheduled-task runner; do NOT add a second scheduler.

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
