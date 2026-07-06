# Type-duplication triage guide

How to read the type-duplication candidate report, decide what to consolidate,
and record what to leave alone. Companion to the candidate-finder
[`type-duplication-audit.mjs`](./type-duplication-audit.mjs) (#10195) and its
consolidation follow-up (#10201).

> The finder is **advisory**. It emits a ranked, reviewable list — it never
> rewrites source and never fails the build. Consolidation is always a
> deliberate, human-reviewed change.

## Run it

```bash
bun run audit:type-duplication                  # writes the report (below)
bun run audit:type-duplication:self-test        # prove the clustering still fires
bun run audit:type-duplication:check            # advisory drift vs the baseline
bun run audit:type-duplication:update-baseline  # re-baseline after a triaged cleanup
```

Outputs:

- `reports/type-duplication.json` — full machine output (gitignored).
- `test-results/evidence/10195-type-duplication.md` — committed summary.
- `packages/scripts/type-duplication-audit.baseline.json` — per-class counts
  for advisory drift detection (`--check`).

## Candidate classes

| Class | What it finds | Typical action |
| --- | --- | --- |
| Same-name, multi-package | One type name (`ApiResponse`, `ValidationResult`) declared in ≥2 packages | merge, rename, or keep-separate |
| Subset / superset | One type's property keys ⊆ another's | `extends` / `Pick` / `Omit` |
| Structural near-duplicate | Jaccard ≥ 0.6 over `name:type` property signatures | merge / share via `@elizaos/core` |
| Literal-set duplicate | String-literal unions, `enum`s, and `as const` maps that enumerate the **same value set** across ≥2 packages, even under different names | share one union in `@elizaos/core` |
| Runtime schema ↔ exported type | `z.object(...)` and JSON-schema-like `{ type: "object", properties: ... }` validators whose key sets exactly match or strongly overlap exported TS object types | pair shared DTO with runtime validation, or keep separate with a reason |

Plus a weak-type inventory (`as unknown as`, `as any`, explicit `: any`) — the
actionable casts the `type-safety-ratchet` gates.

## When to consolidate

Consolidate only when **ownership and runtime meaning are the same**. The
strongest signals:

1. **A canonical owner already exists** (or there is an obvious inner-layer home).
   Prefer an existing public package contract — usually `@elizaos/core` — over a
   new shared package.
2. **The copies are verbatim or drift-prone.** A value set duplicated by hand
   (a literal-set cluster, an enum) goes stale the moment one copy gains a
   member. That drift is the bug the consolidation prevents.
3. **The dependency direction stays inward.** The shared definition must live
   in a package every consumer already depends on. If consolidating would force
   an outer package to import an inner one's host (e.g. a plugin importing
   `@elizaos/app-core`), the contract belongs further **in** (in `@elizaos/core`),
   not at the host.
4. **The boundary is provable.** You can write a test that the client, the
   server, and the contract owner all reference the one definition.

### Worked example — connector-setup `SetupState` (#10201, accepted)

`SetupState = "idle" | "configuring" | "paired" | "error"` was a literal-set
cluster: declared verbatim in `@elizaos/app-core/api/setup-contract.ts` and
re-mirrored in seven connector setup-routes files (bluebubbles, discord,
discord-local, imessage, signal, telegram bot + account). Every connector
already imports from `@elizaos/core`, and `core` already hosts the
`Route` / `RouteRequest` / `RouteResponse` types — so the contract's inward home
is `core`, not the host. Consolidation:

- `packages/core/src/types/connector-setup.ts` is the single source of truth
  (`SetupState`, `SetupStatusResponse<TDetail>`, `SetupErrorResponse`,
  `SETUP_ERROR_CODES`, `buildSetupError`, `setupPath`).
- `@elizaos/app-core/api/setup-contract` re-exports it (path stability).
- Every connector imports the contract; the local mirrors are gone, and the
  local per-connector `setupError` helpers collapsed into the shared
  `buildSetupError`.
- `plugins/__tests__/setup-routes-contract.test.ts` pins that no connector
  re-declares `SetupState` and that all reference the core contract;
  `packages/core/src/types/connector-setup.test.ts` pins the runtime helpers.

`SetupStatusResponse` was kept **specialized** in `plugin-telegram` (it narrows
`connector: "telegram"` and a bespoke `detail`) — a legitimate refinement built
on the shared `SetupState`, not a mirror.

## When NOT to consolidate

A same-name or same-shape hit is **not** a defect by itself. Leave it alone when:

- **The duplication is deliberate decoupling.** Inlining a tiny type to avoid a
  compile-time dependency is a valid architecture choice — not drift.
- **The packages are independently published / zero-dependency by design.** A
  standalone SDK should not grow a dependency on `@elizaos/core` for a
  three-line `JsonValue`.
- **The copy is generated or vendored from an external source of truth.** The
  fix there is generation/vendoring discipline, never a hand-merge.
- **It is a frozen contract-type copy** that an architecture rule mandates
  (e.g. LifeOps/health contributing `ScheduledTask` without importing
  `plugin-scheduling` internals).
- **The names collide but the concepts differ.** `SetupState` the connector
  lifecycle vs `SetupStateMachineConfig` the onboarding wizard are unrelated;
  merging them would be wrong. Read the declarations, not just the names.
- **It is a local test fake.** Keep test-local fakes local unless they mask a
  production DTO mismatch.

For API boundaries, pair a shared type with **runtime validation** wherever the
input is untrusted — a shared TypeScript type is a compile-time guarantee only.

## Recording reviewed-but-kept-separate findings

Suppress reviewed false positives in
[`type-duplication-audit.allowlist.json`](./type-duplication-audit.allowlist.json)
so re-runs stay low-noise. Every entry needs a written `reason`.

| Field | Suppresses |
| --- | --- |
| `name` | a whole same-name cluster (`{ "name": "Foo", "reason": "…" }`) |
| `pairKey` | one subset/near-duplicate pair (the exact `a.file#a.name <=> b.file#b.name` key from `reports/type-duplication.json`) |
| `memberKey` | one literal-set cluster (the `a\|b\|c` value key from the report) |
| `schemaPairKey` | one runtime-schema/type match (`schema:<file>#<schema> <=> type:<file>#<type>`) |

## Advisory drift baseline

`type-duplication-audit.baseline.json` records the per-class candidate counts
after the first human-reviewed cleanup. `--check` prints the drift vs that
baseline and **exits 0** (advisory) so new local types are never blocked; only
`--check --strict` turns growth into a non-zero exit. Re-baseline with
`--update-baseline` once a new batch of duplicates has been triaged.

## Decision log (#10201)

Families reviewed end to end during the first cleanup pass.

| Family | Verdict | Reason |
| --- | --- | --- |
| `SetupState` + connector-setup contract | **Consolidated** → `@elizaos/core` | Verbatim literal-set + DTO mirrored across 7 connectors; clear inward home; boundary now pinned by tests. |
| `CredentialProviderResult` (12 connector plugins) | **Kept separate** | Inlined on purpose to avoid a compile-time dependency on `@elizaos/plugin-workflow`; the runtime duck-types the service. Allowlisted by name. |
| `ScheduledTask` (health / personal-assistant contract-types) | **Kept separate** | Frozen contract-type copies mandated by the LifeOps/health architecture rule — they must not import `plugin-scheduling` internals. Allowlisted by name. |
| Cloud-API DTOs (`AgentListItemDto`, the `types.cloud-api.ts` copies) | **Kept separate** | `@elizaos/cloud-sdk` mirrors them from the live Cloud API schema ("do not hand-edit"); `packages/ui` and `plugin-elizacloud` vendor that SDK. Fix belongs to generation/vendoring discipline, not a hand-merge. Representative name allowlisted. |
| `JsonValue` / `JsonObject` / `JsonPrimitive` (30+ packages) | **Mostly kept separate** | Standalone/zero-dependency packages (the SDK, electrobun remotes, the `feed` sub-monorepo) redefine the trivial JSON shape on purpose rather than depend on `@elizaos/core`. `core` now publicly exports the family, so in-repo runtime code that already imports `@elizaos/core` *can* migrate opportunistically — but a blanket merge is wrong. Not blanket-allowlisted, so genuine in-repo opportunities stay visible. |
