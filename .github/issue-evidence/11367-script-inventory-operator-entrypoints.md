# Issue #11367 - script inventory operator entrypoints

## What changed

`packages/scripts/audit-scripts-inventory.mjs` now treats every named root
`package.json` script as a lower-priority operator entrypoint. Files reached
only from these commands are categorized as
`reachable-from-operator-script`, not `orphan`, and each direct root caller is
listed in `operatorScriptCallers`.

## Verification

```bash
bun test packages/scripts/__tests__/audit-scripts-inventory.test.ts
```

Result: 9 tests passed, 0 failed, 206 assertions.

```bash
bunx @biomejs/biome check packages/scripts/audit-scripts-inventory.mjs \
  packages/scripts/__tests__/audit-scripts-inventory.test.ts
```

Result: 2 files checked, no fixes needed.

```bash
node packages/scripts/audit-scripts-inventory.mjs --json | jq \
  '{summary:.summary, devAllFile:(.files[]|select(.file=="dev-all.mjs")), orphanFiles:[.files[]|select(.category=="orphan")|.file]}'
```

Key inspected output:

```json
{
  "summary": {
    "totalFiles": 90,
    "orphanFiles": 0,
    "rootScriptsByCategory": {
      "reachable-from-operator-script": 134,
      "orphan": 0
    },
    "operatorScriptFileReferences": 96,
    "documentationFileReferences": 411
  },
  "devAllFile": {
    "file": "dev-all.mjs",
    "category": "reachable-from-operator-script",
    "operatorScriptCallers": [
      {
        "packageJson": "package.json",
        "script": "dev:all"
      }
    ]
  },
  "orphanFiles": []
}
```

```bash
bun run audit:scripts:inventory
```

Result: passed. Summary showed 90 total `packages/scripts/*.mjs` files, 16
`reachable-from-operator-script` files, 3 `reachable-from-docs` files, and 0
orphan files.

```bash
bun run audit:scripts
```

Result: passed. The audit reported no orphan, no-op, or broken scripts.

```bash
bun run verify
```

Result: failed before reaching this change path in the existing type-safety
ratchet:

```text
as unknown as: 80 current > 77 baseline
`?? {}` (core/agent/app-core): 379 current > 377 baseline
```

UI evidence: N/A - this is a repository automation script and unit test change
with no rendered UI surface.
