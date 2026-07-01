# Issue #10077 - prompts Turbo cache outputs

## Scope

Fixes the highest-priority `@elizaos/prompts#build` cache correctness slice from
#10077. The task is cacheable again, restores the generated prompt/action
artifacts, and hashes plugin TypeScript because the generator scans
`plugins/**/*.ts`.

## Evidence

### Turbo dry-run

Command:

```bash
node packages/scripts/run-turbo.mjs run build --filter=@elizaos/prompts --dry-run=json
```

Parsed `@elizaos/prompts#build` task:

```text
cache   : True
outputs : ../../packages/core/src/generated/action-docs.ts, specs/actions/plugins.generated.json
inputs  : ../../plugins/**/*.ts, package.json, scripts/**, specs/**, src/**
```

### Generator

Command:

```bash
bun run --cwd packages/prompts build
```

Result:

```text
Wrote 97 plugin actions to packages\prompts\specs\actions\plugins.generated.json
Formatted 1 file in 498ms. Fixed 1 file.
Generated action/provider docs.
```

No generated artifact diff remained after the build.

### Tests and checks

```bash
bun test packages/scripts/__tests__/turbo-prompts-cache-outputs.test.ts
```

Result: 1 pass, 0 fail.

```bash
bun run --cwd packages/prompts test
```

Result: 25 pass, 0 fail.

```bash
bun run biome check turbo.json packages/scripts/__tests__/turbo-prompts-cache-outputs.test.ts
```

Result: checked 2 files, no fixes applied.

```bash
git diff --check
```

Result: pass.

### Filtered Turbo build attempt

Command:

```bash
node packages/scripts/run-turbo.mjs run build --filter=@elizaos/prompts --output-logs=new-only
```

Result: blocked before `@elizaos/prompts#build` by the local Windows dependency
store. `@elizaos/core#build` failed resolving missing `drizzle-orm` package
files such as `./sql/index.js`, `./subquery.js`, and `./table.js` from
`node_modules/.bun/drizzle-orm@0.45.2+4eb8acfd097b6b37/node_modules/drizzle-orm`.

## Evidence Type Notes

- Backend logs: N/A, no backend code path changed.
- Frontend logs: N/A, no frontend runtime path changed.
- Screenshots: N/A, no UI changed.
- Video: N/A, no UI flow changed.
- Real-LLM trajectory: N/A, build orchestration cache metadata only.
- Audio: N/A, no voice path changed.
