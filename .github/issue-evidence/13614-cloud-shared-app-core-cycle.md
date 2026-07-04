# Issue #13614 — cloud-shared/app-core cycle break

## What changed

- Removed the production `@elizaos/cloud-shared -> @elizaos/app-core` dependency edge.
- Replaced cloud-shared's lazy import of `@elizaos/app-core/account-pool` with an injected `TeamAccountPoolFactory`.
- Registered the concrete app-core `AccountPool` implementation from the cloud API chat completions route, which is the production caller of team pooled credentials.
- Kept the real team-pool tests on app-core's `AccountPool` by injecting the factory explicitly in the test registry.

## Verification

Commands run from `/Users/shawwalters/.codex/wt-project12-13614`.

```bash
jq -e '.dependencies["@elizaos/app-core"] == null' packages/cloud/shared/package.json
```

Result: passed and printed `cloud-shared has no app-core dependency`.

```bash
rg -n '@elizaos/app-core' \
  packages/cloud/shared/package.json \
  packages/cloud/shared/src/lib/services/team-credential-pool \
  -g '!**/__tests__/**'
```

Result: no production references found.

```bash
bunx biome check \
  packages/cloud/shared/src/lib/services/team-credential-pool/registry.ts \
  packages/cloud/shared/src/lib/services/team-credential-pool/pool-deps.ts \
  packages/cloud/shared/src/lib/services/team-credential-pool/index.ts \
  packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts \
  packages/cloud/api/v1/chat/completions/route.ts \
  packages/cloud/api/package.json \
  packages/cloud/shared/package.json
```

Result: passed, `Checked 7 files ... No fixes applied.`

```bash
node <workspace dependency-closure check>
```

Result: `OK: @elizaos/cloud-shared dependency closure does not reach @elizaos/app-core across 14 workspace packages.`

```bash
bun run --cwd packages/cloud/shared typecheck
```

Patch-specific result: no `team-credential-pool` errors after the fix.

Remaining pre-existing failures in this local worktree:

- `../../core/src/i18n/action-search-keywords.ts`: missing generated `validation-keyword-data`.
- `../../core/src/i18n/validation-keywords.ts`: missing generated `validation-keyword-data`.
- `../../shared/src/config/brand-env-aliases.ts`: existing `syncElizaKey` type error.
- `../../shared/src/i18n/keyword-matching.ts`: missing generated `validation-keyword-data`.

```bash
bun run --cwd packages/cloud/api typecheck
```

Patch-specific result: no `team-credential-pool` or chat route errors after the fix.

Remaining pre-existing/local-install failures:

- app-core source import cannot resolve `@elizaos/auth/*` subpaths in this throwaway worktree's node_modules layout.
- the same generated i18n and `brand-env-aliases.ts` failures listed above.

```bash
bun test packages/cloud/shared/src/lib/services/__tests__/team-credential-pool.test.ts
```

Result: blocked before exercising the team-pool code because the test setup cannot import `@elizaos/cloud-routing` from `packages/core/src/cloud-routing.ts` in this isolated worktree. The downstream test failures are all from undefined setup imports after that initial import failure.

```bash
bunx turbo run build --dry-run=json --filter=@elizaos/cloud-shared
```

Result: abandoned after 90 seconds with no output; the process did not respond to interrupt and was killed before continuing with deterministic package.json graph checks.
