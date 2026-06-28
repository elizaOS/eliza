# 9145 remote app deploy evidence

Issue: https://github.com/elizaOS/eliza/issues/9145

## What this proves

- Dashboard app deploy triggers `POST /api/v1/apps/:id/deploy`.
- The client can poll `GET /api/v1/apps/:id/deploy/status` until the deployment reaches `READY`.
- A local app definition remains stable after deploy, while the deployed app is classified as remote.
- The mock cloud control plane can process DB-backed `APP_DEPLOY` jobs and expose a reachable production URL.
- App deploy jobs still work when heavy job payloads are offloaded, because `appId` is retained in inline job data.

## Commands run

```bash
bun run --cwd packages/ui test src/cloud/applications/lib/apps.deploy.test.ts
```

Result: passed, 1 file, 9 tests.

```bash
bun --conditions=eliza-source test \
  packages/cloud/shared/src/lib/services/__tests__/app-deploy-job-service.test.ts \
  packages/cloud/shared/src/lib/services/__tests__/app-deployments-helpers.test.ts \
  packages/cloud/shared/src/lib/services/__tests__/app-credits-ledger.test.ts \
  packages/cloud/shared/src/lib/services/app-credit-math.test.ts \
  packages/cloud/shared/src/db/repositories/jobs.test.ts
```

Result: passed, 39 tests, 104 expects.

```bash
bun run --cwd packages/cloud/shared test jobs.test.ts
```

Result: passed, 1 test, 5 expects.

```bash
bun run --cwd packages/test/cloud-e2e test tests/remote-app-deploy.spec.ts
```

Result: passed, 1 Playwright test.

```bash
/Users/shawwalters/.bun/bin/bunx biome check --write \
  packages/ui/src/cloud/applications/lib/apps.ts \
  packages/ui/src/cloud/applications/lib/apps.deploy.test.ts \
  packages/ui/src/cloud/applications/components/app-overview.tsx \
  packages/test/cloud-e2e/src/fixtures/env.ts \
  packages/scripts/cloud/admin/dev/cloud-api-dev.mjs \
  packages/test/cloud-e2e/playwright.config.ts \
  packages/test/cloud-e2e/src/helpers/test-fixtures.ts \
  packages/test/cloud-mocks/src/control-plane/server.ts \
  packages/test/cloud-e2e/tests/remote-app-deploy.spec.ts \
  packages/cloud/shared/src/db/repositories/jobs.ts \
  packages/cloud/shared/src/db/repositories/jobs.test.ts
```

Result: passed after formatting two files.

```bash
bun run cloud:e2e -- remote-app-deploy.spec.ts example-apps-showcase.spec.ts
```

Result: passed, 2 Playwright tests. The mock Redis cache DEL warning appeared
again during teardown; it did not fail the run.

## Full verify

```bash
PATH="/Users/shawwalters/.bun/bin:$PATH" /Users/shawwalters/.bun/bin/bun run verify
```

Result: passed, 509 successful tasks.

## Evidence notes

- Screenshots/video: N/A for this change. The new proof is API and mock-runtime e2e coverage rather than a visual redesign.
- Real LLM trajectory: N/A. This change is deploy plumbing, dashboard polling, mock control-plane behavior, and job persistence.
- Subscription decision: no new subscription lane was added. Existing app monetization remains based on app credits, and the targeted app credit tests above passed.
