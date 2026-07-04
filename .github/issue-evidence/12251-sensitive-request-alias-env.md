# #12251 sensitive-request cloud env alias migration

## Scope

This slice migrates the sensitive-request cloud link adapters off raw
`process.env.ELIZAOS_CLOUD_*` reads and onto the alias-aware, non-mutating
`readAliasedEnv` helper introduced by PR #13356.

Changed paths:

- `packages/app-core/src/services/sensitive-requests/cloud-link-adapter.ts`
- `packages/app-core/src/services/sensitive-requests/public-link-adapter.ts`
- `packages/app-core/src/services/sensitive-requests/cloud-link-adapter.test.ts`
- `packages/app-core/src/services/sensitive-requests/public-link-adapter.test.ts`

## Manual Review

Reviewed the two adapter diffs and confirmed runtime settings still take
precedence over env fallback. The fallback now resolves configured
brand<->canonical aliases without writing `ELIZAOS_CLOUD_API_KEY` or
`ELIZAOS_CLOUD_BASE_URL` into `process.env`.

This PR is stacked on #13356 because it depends on the new `readAliasedEnv`
export and non-mutating alias reader.

## Verification

```bash
bun run --cwd packages/app-core test src/services/sensitive-requests/cloud-link-adapter.test.ts src/services/sensitive-requests/public-link-adapter.test.ts
```

Result:

```text
Test Files  2 passed (2)
Tests       18 passed (18)
```

```bash
bunx @biomejs/biome check packages/app-core/src/services/sensitive-requests/cloud-link-adapter.ts packages/app-core/src/services/sensitive-requests/public-link-adapter.ts packages/app-core/src/services/sensitive-requests/cloud-link-adapter.test.ts packages/app-core/src/services/sensitive-requests/public-link-adapter.test.ts
```

Result:

```text
Checked 4 files in 107ms. No fixes applied.
```

Raw `bun test` for the same two files executed all 18 assertions successfully
but exited nonzero after dumping repository-wide coverage, so the package-local
Vitest runner above is the recorded verification.
