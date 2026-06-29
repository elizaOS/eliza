# Evidence — #9955 keyword search SCALE test (follow-up to #10145)

The keyword message-search feature itself landed in **#10145**. That PR shipped
unit + endpoint tests on small fixtures and a 20k-row in-memory loop, but **no
real-DB scale test** and **no EXPLAIN proof** that the `ILIKE` is pushed down at
the ≥2k-conversations / ≥200k-messages bar the issue's acceptance criteria
require ("verified by query log / explain — not a multi-room JS scan").

This adds exactly that test:
`plugins/plugin-sql/src/__tests__/integration/memory-keyword-search.real.test.ts`
— a real PGlite database seeded with **2,000 rooms / 200,000 message rows**.

```
 ✓ uses a pushed-down SQL ILIKE, not a full-table JS scan (EXPLAIN)
 ✓ finds the rare needle — the OLDEST row, far outside the recent window  220ms
 ✓ returns all common-needle hits across conversations, ranked            224ms
 ✓ is case-insensitive
 ✓ returns nothing for a needle that does not occur
 ✓ treats LIKE metacharacters as literals (no wildcard expansion)
 Tests  7 passed (7)   ~26s for 200k rows
```

The EXPLAIN plan proves the predicate is evaluated by the database (a JS scan
would never appear in a DB plan):

```
Seq Scan on memories
  Filter: ((type = 'messages') AND ((content ->> 'text') ~~* '%pineapple%'))
```

`~~*` is Postgres' ILIKE operator. The single OLDEST row of 200k is retrieved in
~220 ms, proving the keyword path reaches past the recent window into the full
table via the SQL predicate (the `textContains` → `getMemories` path merged in
#10145).

Real-LLM trajectory / audio: **N/A** (pure data-layer retrieval test).

> Run in an isolated worktree that shares the parent `node_modules`, so this was
> executed with the repo's vitest binary directly against the source. CI runs it
> in the `*.real.test.ts` lane.
