# Issue #11743 - Cloud files CRUD evidence

## Implementation reviewed

- Added org-scoped `/api/v1/files` list/upload and `/api/v1/files/:id` get/delete routes.
- Added additive `cloud_files` schema, migration, repository, and service.
- Uploads write bytes to the existing Worker `BLOB` R2 binding under `cloud-files/<org>/<date>/<file-id>-<sha>.ext`, then persist metadata in `cloud_files`.
- Delete is scoped by organization, soft-deletes the DB row, and deletes the R2 object only after no active record references the storage key.
- Upload cleanup is covered: if R2 upload succeeds but DB metadata creation
  fails, the service deletes the just-written object before rethrowing.
- `/api/v1/files/:id` validates UUID shape before calling the service so
  malformed IDs return a client validation error instead of leaking to the DB.
- The local agent `/api/files` and content-addressed media store contract were not changed.

## Artifact review

- Upload fixture: `hello` bytes in `hello.png`.
- Expected SHA-256, manually checked in service test assertion: `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`.
- Storage URL shape manually reviewed from the service test artifact: `https://blob.test/cloud-files/<org>/<date>/<id>-<sha-prefix>.png`.
- DB artifact shape manually reviewed from service test create payload: `organization_id`, `user_id`, `source=upload`, `kind=image`, `filename`, `mime_type`, `size_bytes`, `sha256`, `storage_key`, `storage_url`, and caller-supplied metadata.

## Validation

- `bun run install:light`
- `bun run --cwd packages/core build`
- `bun run --cwd packages/cloud/api codegen`
- `bunx @biomejs/biome check --write packages/cloud/api/v1/files packages/cloud/api/__tests__/cloud-files-route.test.ts packages/cloud/shared/src/db/schemas/cloud-files.ts packages/cloud/shared/src/db/repositories/cloud-files.ts packages/cloud/shared/src/lib/services/cloud-files.ts packages/cloud/shared/src/lib/services/cloud-files.test.ts packages/cloud/shared/src/db/schemas/index.ts packages/cloud/shared/src/db/repositories/index.ts`
- `bun run --cwd packages/cloud/shared typecheck`
- `bun run --cwd packages/cloud/api typecheck`
- `bun test packages/cloud/shared/src/lib/services/cloud-files.test.ts packages/cloud/api/__tests__/cloud-files-route.test.ts` - 11 pass / 0 fail
- `bun run --cwd packages/cloud/shared lint`
- `bun run --cwd packages/cloud/api lint`
- `git diff --check`

## N/A

- UI screenshots/video: N/A - no dashboard surface was added.
- Live media generation: N/A - this PR adds uploaded/generated asset library plumbing; live generated media evidence remains tracked by #11745.
- Real LLM trajectories: N/A - no agent/action/provider/prompt/model behavior changed.
