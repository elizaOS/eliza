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
bun run --cwd packages/ui test apps.deploy.test.ts
```

Result: passed, 1 file, 9 tests.

```bash
bun run --cwd packages/cloud-shared test jobs.test.ts
```

Result: passed, 1 test, 5 expects.

```bash
bun run cloud:e2e -- remote-app-deploy.spec.ts example-apps-showcase.spec.ts
```

Result: passed, 2 Playwright tests. The mock Redis cache DEL warning appeared
again during teardown; it did not fail the run.

## Full verify

```bash
bun run verify
```

Result: passed, 509 Turbo tasks.

## Evidence notes

- Screenshots/video: N/A for this change. The new proof is API and mock-runtime e2e coverage rather than a visual redesign.
- Real LLM trajectory: N/A. This change is deploy plumbing, dashboard polling, mock control-plane behavior, and job persistence.
- Subscription decision: no new subscription lane was added. Existing app monetization remains based on app credits, and the targeted app credit tests above passed.
