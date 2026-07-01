# Issue #9853 - tenant-scope gate recursive pk predicates

Date: 2026-06-29
Branch: `codex/fix/cloud-tenant-scope-gate`

## Change

- Hardened `packages/cloud/shared/scripts/check-tenant-scope.ts` so the static tenant-scope gate catches pk-only predicates when wrapped in:
  - `and(eq(table.id, ...))`
  - `or(eq(table.id, ...))`
  - `inArray(table.id, ...)`
  - `and(...conditions)` where `conditions` is a simple `const` array of pk-only predicates.
- Kept the existing narrow semantics: a predicate on another column, such as `organization_id`, means the query is not considered pk-only by this gate.
- Expanded tenant-scope fixtures and tests to prove both the new detections and scoped non-regressions.

## Validation

Passed:

```text
bun test packages/cloud/shared/src/db/repositories/__tests__/tenant-scope-gate.test.ts
2 pass
```

```text
bun run --cwd packages/cloud/shared check:tenant-scope
tenant-scope gate: no unannotated pk-only reads across 74 repository file(s)
```

```text
bunx @biomejs/biome check packages/cloud/shared/scripts/check-tenant-scope.ts packages/cloud/shared/scripts/__fixtures__/tenant-scope/unscoped.ts packages/cloud/shared/scripts/__fixtures__/tenant-scope/scoped.ts packages/cloud/shared/src/db/repositories/__tests__/tenant-scope-gate.test.ts
Checked 4 files. No fixes applied.
```

```text
bun run --cwd packages/cloud/shared lint
Checked 1195 files. No fixes applied.
Only existing Biome config schema/deprecation info emitted.
```

```text
git diff --check
passed
```

Blocked locally:

```text
bun install
timed out after 364s
```

```text
bun run verify
timed out after 304s
```

```text
bun run --cwd packages/cloud/shared typecheck
bun: command not found: tsgo
```

## Evidence notes

- Backend logs: N/A; this is a static CI gate script and fixture test.
- Real-LLM trajectory: N/A; no agent behavior changed.
- Screenshots/video/audio: N/A; no UI or media surface changed.
