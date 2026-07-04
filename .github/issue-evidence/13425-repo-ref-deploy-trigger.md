# 13425 repo/ref deploy trigger evidence

## What changed

Cloud Apps deployment from the app shell now requires a Git repository URL, a
full 40-character commit SHA, and an optional Dockerfile path before it calls
`POST /api/v1/apps/:id/deploy`. The smoke test asserts the actual request body:

```json
{
  "repoUrl": "https://github.com/elizaOS/eliza.git",
  "ref": "0123456789abcdef0123456789abcdef01234567",
  "dockerfile": "Dockerfile"
}
```

## Verification

- `bun run --cwd packages/ui test src/cloud/applications/lib/apps.deploy.test.ts`
  - Passed: 15 tests.
- `bunx biome check packages/ui/src/cloud/applications/lib/apps.ts packages/ui/src/cloud/applications/lib/apps.deploy.test.ts packages/ui/src/cloud/applications/components/app-overview.tsx packages/ui/src/i18n/locales/en.json packages/app/test/ui-smoke/cloud-apps-deploy-deeplink.spec.ts`
  - Passed.
- `bun run --cwd packages/ui typecheck`
  - Passed.
- `bun run --cwd packages/app test:e2e test/ui-smoke/cloud-apps-deploy-deeplink.spec.ts`
  - Passed: the deep-link Apps flow mounted the detail page, filled the repo/ref
    deployment form, and observed the expected Cloud API payload.
- `bun run --cwd packages/app audit:app`
  - The changed `builtin-apps` audit route passed all four viewports.
  - The full audit exited nonzero after 372/373 passing captures because the
    runner hit `ENOSPC` while writing the unrelated
    `plugin-todos-tui mobile-portrait` screenshot. The failure was a filesystem
    write error, not an app visual assertion.

## Manual Review

I opened the Cloud Apps detail screenshot produced by the passing smoke run. The
deployment panel is compact, the repository URL / commit SHA / Dockerfile fields
fit without overlap, and the submit button remains visible in the first viewport.
