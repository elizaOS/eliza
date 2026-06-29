# Issue #10078 - declaration emit without second typecheck

## Scope

Partial #10078 build-performance slice. Remaining declaration-emission build
paths now pass `--noCheck`, so `build` emits `.d.ts` files without re-running a
full TypeScript semantic check. Type safety remains owned by the separate
`typecheck`/`tsgo --noEmit` lanes.

Changed emit paths:

- `packages/core/build.ts`
- `packages/elizaos/templates/plugin/build.ts`
- `plugins/plugin-streaming/package.json`
- `plugins/plugin-wechat/package.json`

## Evidence

### Regression Guard

Command:

```bash
bun test packages/scripts/__tests__/declaration-emit-no-check.test.ts
```

Result:

```text
1 pass
0 fail
```

The guard scans tracked `packages/` and `plugins/` build scripts/package build
commands for `tsc --emitDeclarationOnly` without `--noCheck`.

### Formatting

Command:

```bash
bun run biome check packages/scripts/__tests__/declaration-emit-no-check.test.ts packages/core/build.ts packages/elizaos/templates/plugin/build.ts plugins/plugin-wechat/package.json plugins/plugin-streaming/package.json
```

Result:

```text
Checked 4 files in 1291ms. No fixes applied.
```

### Affected Builds and Tests

Command:

```bash
bun run --cwd plugins/plugin-streaming build
```

Result: passed. The logged command includes
`tsc --declaration --emitDeclarationOnly --noEmit false --noCheck`.

Command:

```bash
bun run --cwd plugins/plugin-wechat build
```

Result: passed. The logged command includes
`tsc --declaration --emitDeclarationOnly --noEmit false --noCheck --outDir dist --rootDir src`.

Command:

```bash
bun run --cwd packages/elizaos test
```

Result:

```text
7 passed
46 passed
```

Command:

```bash
bun run --cwd packages/elizaos build
```

Result: passed. No tracked generated manifest/template diff remained.

### Repository Check

Command:

```bash
git diff --check
```

Result: pass.

### Local Core Build Limit

Command:

```bash
bun run --cwd packages/core build
```

Result: blocked during Bun bundling by the existing local Windows dependency
store issue in `drizzle-orm`, before this change's declaration emit path is the
meaningful failure point. Representative errors:

```text
Could not resolve: "./sql/index.js"
Could not resolve: "./subquery.js"
Could not resolve: "./table.js"
```

## Evidence Type Notes

- Backend logs: N/A, build-command configuration only.
- Frontend logs: N/A, no frontend runtime path changed.
- Screenshots: N/A, no UI changed.
- Video: N/A, no user flow changed.
- Real-LLM trajectory: N/A, build orchestration/performance only.
- Audio: N/A, no voice path changed.
