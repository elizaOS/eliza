# Issue #9948 - app-core owner route gate

Date: 2026-06-29
Branch: `codex/fix/app-core-owner-route-gate`

## Change

- Added `ensureRouteMinRole(req, res, state, minRole)` in `packages/app-core/src/api/auth.ts`.
- The helper preserves the existing route auth paths:
  - trusted loopback requests resolve to `OWNER`;
  - cookie sessions still require CSRF for state-changing methods;
  - session bearer auth is still accepted;
  - Android `ELIZA_REQUIRE_LOCAL_AUTH=1` configured bearer compatibility remains `OWNER`;
  - owner identities resolve to `OWNER`;
  - machine identities resolve to `USER`.
- Switched `/api/secrets/*` in `packages/app-core/src/api/server.ts` from binary `ensureRouteAuthorized` to `ensureRouteMinRole(..., "OWNER")`.

## Validation

Passed:

```text
bunx vitest run packages/app-core/src/api/__tests__/ensure-route-min-role.test.ts --environment node
Test Files  1 passed (1)
Tests       5 passed (5)
```

```text
bunx @biomejs/biome check packages/app-core/src/api/auth.ts packages/app-core/src/api/auth/index.ts packages/app-core/src/api/server.ts packages/app-core/src/api/__tests__/ensure-route-min-role.test.ts
Checked 4 files. No fixes applied.
```

```text
git diff --check
passed
```

Blocked locally:

```text
bun install
Resolved, downloaded and extracted [430]
exit code 1 with no additional captured error line
```

```text
bun run verify
@elizaos/logger:build: bun: command not found: tsc
error: script "verify" exited with code 1
```

```text
bun run --cwd packages/app-core typecheck
bun: command not found: tsgo
```

```text
bunx -p typescript tsc --noEmit -p packages/app-core/tsconfig.json --pretty false
timed out after 244s without diagnostics
```

```text
bunx vitest run packages/app-core/src/api/__tests__/ensure-min-role.test.ts --environment node
After bun install repaired handlebars/chalk, this older test still blocks on:
Error: Cannot find module './generated/validation-keyword-data.ts' imported from packages/core/src/i18n/validation-keywords.ts
```

## Evidence notes

- Backend logs: N/A for this unit-scope route guard slice; the regression is covered by direct handler assertions for owner, machine, CSRF, and configured-token paths.
- Real-LLM trajectory: N/A; no agent prompt/model behavior changed.
- Screenshots/video/audio: N/A; no UI surface changed.
