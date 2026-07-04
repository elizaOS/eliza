# Issue #12266 - app-core database row count fallback

## Scope

This chunk fixes the `packages/app-core` database rows route count fallback called out in issue #12266. The route no longer treats a missing or malformed `count(*)` result as `0`; it throws an `ElizaError` with:

- `code`: `DB_COUNT_UNAVAILABLE`
- `context`: `{ "table": "\"schema\".\"table\"" }`
- `severity`: `ephemeral`

The row query is not executed after a malformed count result. Numeric string counts such as `"7"` still parse to `7`.

## Verification

Run on July 4, 2026 from branch `codex/fix-12266-appcore-db-count`.

```bash
bun run --cwd packages/app-core test -- src/api/database-rows-compat-routes.test.ts
```

Result: passed, 1 file / 6 tests.

```bash
bunx @biomejs/biome check \
  packages/app-core/src/api/database-rows-compat-routes.ts \
  packages/app-core/src/api/database-rows-compat-routes.test.ts
```

Result: passed, 2 files checked.

```bash
bun run --cwd packages/app-core build
```

Result: passed.

```bash
bun run audit:error-policy-ratchet
```

Result: passed with no new fallback slop.

```bash
bun run --cwd packages/app-core typecheck
```

Result: failed on unrelated existing `plugin-local-inference` downloader type errors:

- `plugins/plugin-local-inference/src/services/downloader.ts:963`
- `plugins/plugin-local-inference/src/services/downloader.ts:1052`

Both report `Argument of type '{ error: unknown; }' is not assignable to parameter of type 'string'.`

## Root Verify

`bun run verify` was last run on this develop line during the preceding #12272 chunk and failed in unrelated `@elizaos/cloud-ui#lint` import/export ordering and formatting findings under `packages/cloud-ui/src/approvals/*` and `packages/cloud-ui/src/index.ts`. Those files are outside this branch's touched files.

## Evidence Matrix

- Backend logs: N/A - this is a direct API route error-path unit test with the SQL adapter seam stubbed at the route dependency boundary.
- Frontend screenshots/video: N/A - no UI surface changed.
- Real database artifact: N/A for this small chunk - the regression drives the route's real count parsing and confirms malformed count results stop before row reads; no schema/data migration changed.
- Real-LLM trajectories: N/A - no prompt/action/provider/model behavior changed.
- Domain artifact: `packages/app-core/src/api/database-rows-compat-routes.test.ts` asserts a malformed count row throws `DB_COUNT_UNAVAILABLE` and never runs `SELECT *`.
