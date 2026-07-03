# Issue #10450: per-organization app creation cap

## Scope

This slice covers the remaining local code hardening item from #10450: a
per-organization app creation cap.

Implemented behavior:

- App creation is limited per organization by `ELIZA_CLOUD_MAX_APPS_PER_ORG`.
- Invalid or unset `ELIZA_CLOUD_MAX_APPS_PER_ORG` falls back to a conservative
  default of `25`.
- `AppsService.create()` checks the cap before creating the one-time app API key.
- The repository insert path also enforces the cap inside a transaction after
  locking the organization row, so concurrent creates for the same org serialize
  before counting and inserting.
- If a transaction-level cap rejection or insert failure happens after an API key
  was created, the service deletes that key before returning/throwing.
- `POST /api/v1/apps` maps the typed cap error to HTTP `429` with
  `code: "app_creation_limit_reached"` and the configured `limit`.

## Validation

Base commit: `01b3ca36a9 test(bun-runtime): extract + device-test the agent-service selection rule (#9967) (#10466)`

Commands run from `/home/shaw/eliza/eliza-issue-10450-app-cap`:

```bash
bun run install:light
node packages/shared/scripts/generate-keywords.mjs --target ts
bun run --cwd packages/contracts build
bun run --cwd packages/core build:node
git diff --check
bunx @biomejs/biome check packages/cloud/shared/src/db/repositories/apps.ts packages/cloud/shared/src/lib/services/apps.ts packages/cloud/api/v1/apps/route.ts packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts packages/cloud/api/__tests__/apps-crud.integration.test.ts
bun test packages/cloud/shared/src/db/repositories/__tests__/apps.test.ts --reporter=dot
bun test packages/cloud/api/__tests__/apps-crud.integration.test.ts -t "429 when the organization app creation cap is reached" --reporter=dot
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
```

Observed results:

- Focused Biome: `Checked 5 files in 90ms. No fixes applied.`
- PGlite-backed apps repository/service suite: `17 pass`, `0 fail`,
  `74 expect() calls`.
- Targeted API route cap test: `1 pass`, `38 filtered out`, `0 fail`,
  `5 expect() calls`.
- `packages/cloud/shared` typecheck: passed.
- `packages/cloud/api` typecheck: passed.

## Full-suite note

`bun test packages/cloud/api/__tests__/apps-crud.integration.test.ts --reporter=dot`
was also attempted. The new cap route branch passed, then the suite failed later
in the pre-existing `PUT /api/v1/apps/:id` linked-character update case because
the test touches the real `user_characters` repository/table while this suite
mocks app storage and does not create that table:

```text
error: relation "user_characters" does not exist
Expected: 200
Received: 500
```

This failure is unrelated to the app cap path; the targeted create-route test is
included above for the changed branch.

## Screenshots / Android

N/A. This is Cloud API/backend quota and persistence logic with no app UI or
native Android surface. The behavior is covered by real-schema PGlite tests, a
route-level integration test for the HTTP response, and package typechecks.
