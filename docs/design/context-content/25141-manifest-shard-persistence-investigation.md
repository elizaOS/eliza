# Issue #25141 investigation: durable manifest shard persistence

Status: investigation complete, pre-implementation · Date: 2026-08-27 · Base: `027ccfa2` (origin/develop HEAD, worktree `fix/issue-25141-manifest-shard-continuity`)

## Scope

Read-only diagnosis of the gap between the in-memory `CompactionContentManifest`
derivation and the issue's acceptance criteria for durable, restart-safe,
ordered, authorized manifest shards. No code was changed.

## Verdict

**Gap CONFIRMED.** `deriveCompactionContentManifest` and
`validateCompactionContentManifest` exist, are unit-tested, and are exported,
but have **zero production callers** and **no durable storage of any kind** —
no table, no file store, no shard layer, no producer.

### Evidence (all paths at `027ccfa2`)

| Claim | Evidence |
| --- | --- |
| Derivation has no production caller | `rg deriveCompactionContentManifest` matches only `packages/core/src/runtime/content-access-manifest.ts` (definition), its `.test.ts`, and the design spec. Exported unused at `packages/core/src/index.node.ts:264`. |
| Validator has no other caller | `validateCompactionContentManifest` referenced only by the derivation, `packages/core/src/types/content-manifest.test.ts`, and the spec. Types exported at `packages/core/src/types/index.ts:34`. |
| No shard/persistence table | `packages/core/src/schemas/` (23 `SchemaTable` descriptors) and `plugins/plugin-sql/src/schema/` (35 drizzle files) contain no manifest/shard table. `rg -i shard` over schemas/migrations: zero hits. |
| Nothing writes manifests to the cache table | `cache` writes come only from `runtime.getCache/setCache` callers (image-description, confirmation, notifications, prompt-batcher, onboarding, escalation, push-token, wallet-delta, advanced-memory) — none manifest-related. |
| The archive seam itself is absent | `PlannerTrajectory.archivedSteps` is **initialized empty** (`planner-loop.ts:399,451,5174`) and read everywhere, but never populated by production code. There is no step-archiver today. |
| Where references currently die | Trajectories persist `steps_json` (with `promptData` ReadViews) via `TrajectoriesService` / `packages/agent/src/runtime/trajectory-storage.ts`; the archive/prune path exports rows to `.jsonl.gz` then **deletes them from the table** (`exportRawTrajectoriesToCompressedArchive`, "Step 3: Delete the archived rows"). Content references die with the rows. |

## Recommended persistence seam

**The existing `cache` table through the adapter cache API, plus one additive
compare-and-swap primitive.** Shard key: `content-manifest-shard:{ledgerId}:{sequence}`;
head key: `content-manifest-head:{ledgerId}`.

Why not the alternatives:

- **New drizzle table** — spec §13 *Deferred decisions* explicitly defers
  "new content database tables"; the issue text says shards live "in the
  existing memory/database domain". A new table would contradict the
  checked-in design the issue cites.
- **Atomic-JSON files under the state dir** — violates the repository's
  "no second file store beyond the media store" invariant, is weaker for
  cross-process CAS, and bypasses the RLS/agent-scoping that makes shards
  "authorized".

Why the cache table fits:

- Composite PK `(key, agent_id)` + FK cascade = per-agent authorization
  scoping for free; with `ENABLE_DATA_ISOLATION=true` the table rides
  `apply_entity_rls_to_all_tables()` (`plugins/plugin-sql/src/rls.ts:574`).
- Keys are addressable; `getCaches` batch reads enable ordered traversal.
- One implementation in `BaseDrizzleAdapter` (`plugins/plugin-sql/src/base.ts:5066-5135`)
  covers **both** PgliteDatabaseAdapter and PgDatabaseAdapter (both extend it),
  plus `inMemoryAdapter` — PGLite/Postgres parity by construction.

Required addition: `setCache` is a blind last-writer-wins upsert
(`onConflictDoUpdate`, no revision, base.ts:5098) and **cannot** satisfy
"compare-and-swap safe under concurrent writers". Add an optional additive
adapter method, e.g. `compareAndSwapCache<T>(key, expectedRevision, value)`,
implemented as a conditional `UPDATE cache SET value=… WHERE agent_id=… AND
key=… AND value->>'revision'=…` in `BaseDrizzleAdapter` (jsonb operator is
identical under PGLite and Postgres) and a guarded Map write in
`inMemoryAdapter`. Follow the established revision-CAS precedent in
`packages/core/src/database/world-metadata-cas.ts`
(`WORLD_METADATA_STALE_WRITE` → mirror as `CONTENT_MANIFEST_STALE_PUBLISH`).

## Where the manifest is produced today

**Nowhere.** The natural minimal producer is the trajectory persist path:
`packages/core/src/features/trajectories/TrajectoriesService.ts` already walks
and persists full trajectories each turn and owns the prune seam that deletes
`steps_json` rows. Derive + publish the ledger there (and guard the prune
delete) — no new summary seam needs to exist first. `message.ts` turn-terminal
is the alternative but has a larger blast radius.

## Shard data model

New envelope module (do **not** mutate the frozen v1 manifest type):
`packages/core/src/types/content-manifest-shards.ts`.

```ts
// Shard: one bounded, ordered, immutable slice of the ledger.
interface ManifestShard {
  schemaVersion: 1;              // shard envelope version (distinct from manifest v1)
  ledgerId: string;              // e.g. `${agentId}:trajectory:${trajectoryId}`
  sequence: number;              // 0-based ordinal, strictly increasing
  entries: CompactionContentEntry[]; // ordered, deduped, each re-validated
  entryCount: number;
  byteLength: number;            // canonical-JSON bytes of this shard record
  entriesSha256: string;         // sha256 over canonical serialization
  prevSha256?: string;           // chain link to shard sequence-1 (absent on seq 0)
  nextSequence?: number;         // rollover link (absent on tail)
  createdAt: string;             // ISO-8601 UTC
}

// Head: restart-safe entry pointer + reconciliation totals + CAS token.
interface ManifestHead {
  schemaVersion: 1;
  ledgerId: string;
  headSequence: number;   // 0 — traversal starts at the FIRST shard
  shardCount: number;
  totalEntries: number;
  totalRanges: number;
  ledgerSha256: string;   // rolling chain hash of the tail shard
  revision: number;       // monotonic CAS token
  updatedAt: string;
}
```

- **Canonical serialization:** `validateCompactionContentManifest` (and the new
  shard validator) reconstruct objects with literal key order and skip
  `undefined`, so `JSON.stringify` of a *validated* value is canonical;
  sha256 (node:crypto in the runtime store, not the env-neutral types module)
  is computed over those bytes. This matches the jsonb equality semantics
  already codified in `worldMetadataValueEquals`.
- **Publication protocol (idempotent + CAS):** shards are content-addressed
  and immutable — write all shards first (re-upserting identical bytes is
  harmless), then publish the head via `compareAndSwapCache` on `revision`
  (manifest-last, mirroring the corpus publication rule). A losing concurrent
  writer gets a typed `CONTENT_MANIFEST_STALE_PUBLISH`; it re-reads and either
  no-ops (identical ledger — idempotent) or merges/retries.
- **Rollover:** reuse the existing bounds (`MAX_REFERENCES=256`,
  `MAX_RANGES_PER_REFERENCE=64`, `MAX_BYTES=256 KiB`). Split at entry
  boundaries when a shard would exceed any bound; "repeated rollover" is the
  same mechanism at shard N→N+1.
- **Traversal/verification on read:** load head → strict-validate → batch-read
  shards 0..shardCount-1 via `getCaches` → per shard verify strict keys,
  bounds, `entriesSha256`, `prevSha256` chain, `nextSequence` continuity,
  sequence monotonicity (kills cycles/reorder), and a cross-shard entry-key set
  (kills duplicates/drops) → reconcile `totalEntries`/`totalRanges` against the
  head. Any mismatch is a typed integrity error; never a silent accept.

## Risks

1. **PGLite/Postgres parity** — low: single `BaseDrizzleAdapter`
   implementation; PGLite is real Postgres (WASM). The `*.real.test.ts` lane
   (`plugins/plugin-sql/src/vitest.real.config.ts`: PGLite default, live
   Postgres via `POSTGRES_URL`, `pool:"forks"`) is exactly the shared-vector
   harness the spec requires. RLS vectors belong beside
   `__tests__/integration/postgres/rls-entity.real.test.ts` +
   `rls-test-helpers.ts`. Credentialed lanes must fail (not skip) when
   `POSTGRES_URL` is absent.
2. **Authorization scoping** — cache rows are bound to `this.agentId` at the
   adapter (base.ts:5074, 5108); cross-agent reads are structurally absent
   from the API surface, and RLS enforces it in-database when enabled. The
   ledger records references **without granting**: every later read re-enters
   the production action — FILE `action=read` (`plugins/plugin-coding-tools/src/actions/file.ts`,
   already supports `offset/limit/unit/expectedRevision`) or ATTACHMENT read
   (`packages/core/src/features/working-memory/readAttachmentAction.ts`),
   which revalidate path/room/participant scope and revision. "Reauthorizes on
   read" = the reader goes through those actions, never a raw file handle.
3. **Child-process restart test** — three existing precedents to compose:
   `spawnSync("bun", ["--conditions=eliza-source", …])` runtime contracts
   (`packages/agent/src/runtime/source-start-contract.test.ts`); real
   filesystem PGLite `dataDir` persist→reopen
   (`plugins/plugin-sql/src/__tests__/pglite-lifecycle-serialization.test.ts`
   uses `sourceDir`/`restoredDir`); runtime boot over `PgliteDatabaseAdapter`
   (`packages/agent/src/services/agent-backup-v2-capture.test.ts`).
   Structure: writer fixture child boots a runtime on a tmp dataDir, performs
   bounded FILE reads over a large file with late canaries, publishes the
   ledger, exits; the reader side boots a **fresh** runtime (second child or
   in-process new adapter) on the same dataDir, loads the head, traverses all
   shards, and reaches the canaries through FILE reads.
4. **Retention non-extension** — do not write `expires_at` on shard/head cache
   rows beyond what entries already carry; the ledger must not extend
   authorization or retention (explicit acceptance non-goal; add a guard
   test).
5. **Determinism** — never hash unvalidated objects; only validated,
   key-ordered reconstructions.

## Files to create / modify (minimal-but-complete)

Create:

1. `packages/core/src/types/content-manifest-shards.ts` — shard/head envelope
   types, strict validators (unknown-field reject, bounds, timestamps), chain
   invariants.
2. `packages/core/src/types/content-manifest-shards.test.ts`.
3. `packages/core/src/runtime/content-manifest-ledger.ts` — rollover
   (count/byte/repeated), publish (shards-first + head CAS), load/traverse/
   verify with typed integrity errors.
4. `packages/core/src/runtime/content-manifest-ledger.test.ts` — rollover
   losslessness, idempotent publish, CAS conflict, and direct mutation
   fixtures killing drop/skip/repeat/reorder/cycle/integrity-mismatch.
5. `packages/core/src/runtime/content-manifest-restart.real.test.ts` — PGLite
   dataDir persist→fresh-adapter traverse (shared vectors; Postgres via
   `POSTGRES_URL`).
6. `packages/agent/src/runtime/content-manifest-restart-contract.test.ts` +
   writer fixture — child runtime publishes, fresh reader runtime traverses
   and reaches late canaries via the production FILE action.

Modify:

7. `packages/core/src/types/database.ts` — optional additive
   `compareAndSwapCache` (search all `IDatabaseAdapter` implementors first).
8. `plugins/plugin-sql/src/base.ts` — conditional-update implementation
   (+ unit test in `plugins/plugin-sql/src/__tests__/unit/`).
9. `packages/core/src/database/inMemoryAdapter.ts` — in-memory CAS.
10. `packages/core/src/features/trajectories/TrajectoriesService.ts` — derive +
    publish on trajectory persist; guard the prune delete. Update its tests.
11. Exports: `packages/core/src/index.node.ts`, `packages/core/src/types/index.ts`.

## Acceptance criteria unlikely to fit one PR (scope honesty)

- **§11.1 executable mutant registry**: a checked-in, versioned registry with
  CI-emitted `mutant-kills.json` and a fail-unless-every-ID-killed gate does
  **not exist** anywhere in `packages/scripts` (zero `mutant` hits). A minimal
  PR can kill the six shard mutants with hand-mutated fixtures inside tests,
  but the registry + runner + CI wiring is its own follow-up PR.
- **Scheduled real-Postgres/RLS lane**: adding shared vectors to the
  `*.real.test.ts` lane is doable here; making it a *scheduled* credentialed
  CI lane is infrastructure work outside this repo's core packages.
- **Corpus `elizaos.progressive-content.v2` publication/verifier** (§11 tail):
  a separate subsystem; adjacent to, not required by, shard continuity.
- **"Current summary retains a restart-safe head reference"**: no summary seam
  exists to attach to (compaction was removed). Minimal PR keys the head by
  `ledgerId` (`agentId:trajectory:<id>`) so any future summary can reference it
  without schema change — the *attachment* itself necessarily lands with the
  future compaction PR.

Everything else in the issue's acceptance list (ordered shards, restart-safe
head, next links, integrity metadata, count/byte/serialization/repeated
rollover recovery, idempotent CAS publication, fresh-reader PGLite traversal,
reauthorization through production actions, mutant kills at the fixture level,
no compaction restoration, no retention extension) is achievable in one
implementation PR with the file list above.
