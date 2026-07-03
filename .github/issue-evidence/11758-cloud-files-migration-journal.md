# #11758 follow-up — register 0168_cloud_files in the migration journal

## Defect

PR #11758 (org-scoped `/api/v1/files`, closes #11743) added
`packages/cloud/shared/src/db/migrations/0168_cloud_files.sql` but did NOT
register it in `migrations/meta/_journal.json`. The deploy pipeline's
migrate-db step applies only journal entries, so the `cloud_files` table
would never be created in staging/prod and every `/api/v1/files` request
would 500 against the missing table. Same failure class as #11493.

`drizzle-kit check` does not catch this (verified on develop @ 126166cecc:
"Everything's fine" with the file unregistered) — it only validates
collisions among registered entries.

## Fix

- `_journal.json`: entry `{ idx: 166, tag: "0168_cloud_files" }`.
- New gate: `src/db/migration-journal-registration.test.ts` — every
  non-`.down` migration `.sql` must have a matching journal tag (and vice
  versa), idx contiguous, tags unique.

## Fail-without-fix proof (real run)

Gate test against develop's unregistered journal:

```
(fail) migrations/meta/_journal.json registration > every migration .sql file is registered in the journal
 2 pass / 1 fail   (error names 0168_cloud_files)
```

With the journal entry: `3 pass / 0 fail`.

## Migration applies for real (PGlite, raw SQL verbatim)

```
0168_cloud_files.sql applied OK
re-apply idempotent OK
insert OK
rows after org cascade delete: 0
ALL MIGRATION CHECKS PASSED
```

## Drive-by: develop-red test fix

`src/db/repositories/__tests__/app-frontend-deployments.test.ts` has been
red on develop since #10863 added `appReviewStatusEnum` to the apps schema
(pushSchema failed: `type "app_review_status" does not exist`). Added the
enum to the test's schema set.

## Validation (local, all real)

- `bun test --isolate src/db/repositories/__tests__/ src/lib/services/cloud-files.test.ts src/db/migration-journal-registration.test.ts` — 49 pass / 0 fail
- `bun run --cwd packages/cloud/shared db:check-migrations` — Everything's fine
- `bun run --cwd packages/cloud/shared typecheck` — clean
- `bun run --cwd packages/cloud/api typecheck` — clean
- Biome on changed files — clean

## N/A

- UI screenshots/video: N/A — migration-journal + test-only change, no UI surface.
- Real-LLM trajectories: N/A — no agent/action/provider/prompt/model behavior changed.
