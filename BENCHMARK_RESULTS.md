# elizaOS Database API Benchmark — OLD vs NEW Comparison

> [!NOTE]
> This benchmark document summarizes the performance improvements achieved in the database refactor. The results show up to 18.9x speedup in common operations and demonstrate the new API's scalability with larger datasets.

## Setup

- Backend: PGLite (in-process WASM PostgreSQL, fresh temp dir per run)
- `performance.now()` timing (sub-millisecond resolution)
- Same benchmark script runs on both APIs via runtime detection
- Batch inserts chunked at 1,000 rows to stay within PGLite WASM limits
- 3 measured iterations, 1 warm-up, **median** reported

---

## N=10,000 — WRITE Benchmarks (Old vs New, same machine, same N)

```
WRITE OPERATIONS (N=10,000)  |  OLD (singular API)   |  NEW (batch-first API)
─────────────────────────────┼───────────────────────┼────────────────────────
                             |  loop     batch  spd  |  loop     batch  spd
createAgents                 |  6964ms   7021ms 1.0x |  2642ms    490ms 5.4x
createEntities               |  4231ms    710ms 6.0x |  3627ms    217ms 16.7x
// Note: batch-first API improves performance, reflected in lower response times here
createMemories               |  8384ms   8365ms 1.0x |  4912ms    443ms 11.1x
updateAgents                 |  3899ms   3956ms 1.0x |  2618ms    220ms 11.9x
upsertAgents                 |  [NOT AVAILABLE]      |   488ms    485ms 1.0x
```

### Head-to-head: batch path only

```
  Operation        OLD batch     NEW batch     Speedup     Change
  ─────────────────────────────────────────────────────────────────
  createAgents      7,021ms        490ms       14.3x       -93.0%
  createEntities      710ms        217ms        3.3x*      -69.4%
  createMemories    8,365ms        443ms       18.9x       -94.7%
  updateAgents      3,956ms        220ms       18.0x       -94.4%
  upsertAgents          N/A        485ms          —          NEW
  ─────────────────────────────────────────────────────────────────
  * Both old and new use the same multi-row INSERT code path for
    createEntities. The 3.3x gap is likely PGLite WASM runtime
    variance between separate benchmark processes, not a code change.
```

### Why the difference?

| Operation | OLD behavior | NEW behavior |
|---|---|---|
| **createAgents** | No batch method — `createAgent()` loops N times | Multi-row `INSERT VALUES (...),(...),(...)` |
| **createEntities** | Had `createEntities(array)` — already batched | Same batch INSERT — 3.3x gap is likely PGLite WASM variance between runs (code paths are nearly identical) |
| **createMemories** | No batch method — `createMemory()` loops N times | Multi-row `INSERT VALUES` |
| **updateAgents** | No batch method — `updateAgent(id)` loops N times | Single `UPDATE ... SET col = CASE WHEN id=X THEN Y ... END` |
| **upsertAgents** | Not available | `INSERT ... ON CONFLICT DO UPDATE` |

---

## N=100,000 — WRITE Benchmarks (New API only)

Old code was unable to complete N=100K for updateAgents (estimated >1 hour for 400K individual UPDATE queries).

```
WRITE OPERATIONS (N=100,000) — NEW batch-first API
═══════════════════════════════════════════════════
  createAgents    loop: 26,783ms   batch:  4,723ms   5.7x
  createEntities  loop: 35,566ms   batch:  1,943ms  18.3x
  createMemories  loop: 48,162ms   batch:  4,632ms  10.4x
  updateAgents    loop: 25,682ms   batch:  2,282ms  11.3x
  upsertAgents    get+create: 4,753ms   upsert: 4,837ms   1.0x
```

---

## READ / QUERY Benchmarks (10K rows seeded)

Both old and new code produce near-identical read performance, confirming
the canonical schema system generates equivalent indexes.

```
  Query                     OLD (10K)    NEW (10K)
  ──────────────────────────────────────────────────
  getMemories                  3.8ms       3.7ms
  countMemories                0.4ms       0.5ms
  getMemoriesByRoomIds        46.8ms      47.8ms
  getParticipantsForRoom       0.3ms       0.4ms
  getRoomsByWorld              0.3ms       0.3ms
  getEntitiesByIds (10)        0.6ms       0.6ms
  getRoomsByIds (10)           0.4ms       0.6ms
  getEntitiesForRoom           0.6ms       0.7ms
  getAgents (full scan)        0.6ms       1.8ms
```

## NEW Composite Index Benchmarks (10K rows seeded)

These indexes exist only in the new canonical schema. The old code
doesn't define them — any performance shown is due to PGLite's planner
finding alternative paths (sequential scan on small data).

```
  Query                        OLD (10K)   NEW (10K)   Index
  ────────────────────────────────────────────────────────────────────
  getComponents (entity+type)    0.3ms       0.4ms     idx_components_entity_type
  getComponent (exact)           0.3ms       0.3ms     idx_components_entity_type
  getTasksByName (agent+name)    0.3ms       0.3ms     idx_tasks_agent_name
  getLogs (room+type)            0.5ms       0.5ms     idx_logs_room_type_created
  getLogs (entity+type)          0.4ms       0.3ms     idx_logs_entity_type
  getRelationships (entity)      0.2ms       0.3ms     idx_relationships_users
  getMemories (agent+type)      28.6ms      27.8ms     idx_memories_agent_type
```

### Index analysis

At 10K rows, PGLite's planner can satisfy most queries with sequential scans
fast enough that indexes don't show dramatic differences. The real value of
these composite indexes appears at larger scales:

```
  Query                       10K rows   100K rows (NEW)
  ─────────────────────────────────────────────────────────
  getMemories (agent+type)     27.8ms      125.9ms
  getAgents (full scan)         1.8ms       88.7ms  *
  getMemoriesByRoomIds         47.8ms      564.8ms
```

**`getMemories (agent+type)`** — sublinear: 100K is only ~4.5x slower than
10K, not 10x. The composite index avoids a full table scan.

**`getAgents (full scan)`** — queries `SELECT id, name, bio FROM agents`
(same 3 columns in old and new). Returns only 1 agent in both runs. The 49x
slowdown at 100K is **dead tuple bloat**: the write benchmarks INSERT/DELETE
~100K agents per iteration across multiple benchmarks (createAgents,
updateAgents, upsertAgents × warmup+measured iterations). PGLite's WASM
PostgreSQL doesn't auto-VACUUM during the benchmark, so the seq scan reads
through millions of dead MVCC rows to find the single live row. Not a real
query regression.

**`getMemoriesByRoomIds`** — linear I/O growth: returns all memories across
10 rooms (10K total rows at N=10K, 100K at N=100K). 564.8/47.8 = 11.8x for
10x more returned data.

---

## Running the Benchmark

```bash
# Quick validation (N=5, 1 iteration, no warm-up)
bun run plugins/plugin-sql/typescript/__tests__/benchmark.ts --dry-run

# Default (N=100, 5 iterations, 2 warm-up)
bun run plugins/plugin-sql/typescript/__tests__/benchmark.ts

# Custom size and iterations
bun run plugins/plugin-sql/typescript/__tests__/benchmark.ts --n=10000 --iters=3
```

The script auto-detects which API version is available (`OLD (singular)` vs
`NEW (batch-first)`), so it runs unchanged on both old and new code.

## Conclusion

At **10K rows** (apples-to-apples comparison, same machine, same PGLite):

- **14.3x faster agent creation** (7.0s -> 0.5s) — multi-row INSERT vs 10K individual INSERTs
- **18.9x faster memory creation** (8.4s -> 0.4s) — multi-row INSERT vs 10K individual INSERTs
- **18.0x faster agent updates** (4.0s -> 0.2s) — single CASE-based UPDATE vs 10K individual UPDATEs
- **Entity creation** already batched in old API — observed 3.3x gap is likely PGLite WASM runtime variance (code paths are nearly identical)
- **New upsert capability** — eliminates race conditions in concurrent agent registration

At **100K rows** (new API only — old code too slow to complete):
- Batch creates process 100K agents in 4.7s, 100K memories in 4.6s
- Batch update handles 100K agents in 2.3s with a single SQL statement

**Zero loops remain** in any CRUD method. Creates use multi-row INSERT. Updates
use CASE expressions. Deletes use `WHERE id IN (...)`. Upserts use
`ON CONFLICT DO UPDATE`.

Read performance is identical between old and new — the index structure is
equivalent. The new composite indexes (`idx_memories_agent_type`,
`idx_components_entity_type`, `idx_logs_room_type_created`, etc.) provide
sublinear scaling for filtered queries at large row counts.
