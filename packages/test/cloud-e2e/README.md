# @elizaos/cloud-e2e

Full-stack mock-backed Playwright E2E for the cloud-api + cloud-frontend.

## What boots

1. **PGlite TCP bridge** (via `packages/scripts/cloud/admin/dev/pglite-server.ts`)
2. **Hetzner mock** in-process (`@elizaos/cloud-test-mocks/hetzner`)
3. **Real container-control-plane sidecar** with the explicit
   `ELIZA_TEST_SANDBOX_PROVIDER=memory` test provider
4. **cloud-api worker** subprocess via
   `packages/scripts/cloud/admin/dev/cloud-api-e2e-server.mjs`, a Node-hosted
   Worker fetch adapter
5. **cloud-frontend** subprocess via `vite dev`

Each subprocess streams stdout/stderr into `packages/test/cloud-e2e/.logs/`.

## Running

```bash
bun run cloud:e2e        # headless
bun run cloud:e2e:headed # show browser
bun run cloud:e2e:ui     # Playwright UI mode
```

Per-test the harness:

- seeds a fresh org + user + API key via cloud-shared repositories
- injects an `eliza-test-session` cookie signed with `PLAYWRIGHT_TEST_AUTH_SECRET`
- exposes `stack.mocks.hetzner.store` and `stack.urls.controlPlane` for assertions

## Specs

| File                          | Covers                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `tests/onboarding.spec.ts`    | seeded user reaches dashboard with test-auth session, localStorage writable   |
| `tests/provision.spec.ts`     | create agent → cron tick → sandbox `running`, control-plane sees the sandbox  |
| `tests/deprovision.spec.ts`   | DELETE agent → async `agent_delete` job → polls to `deleted` / 404            |
| `tests/stuck-cleanup.spec.ts` | aged `provisioning` row with no job → cleanup cron → sandbox `error`          |

## Notes

- The mocks live at `packages/test/cloud-mocks`; the harness imports from
  `@elizaos/cloud-test-mocks/hetzner`.
- The memory sandbox provider is guarded by `NODE_ENV=test` or `CLOUD_E2E=1`;
  it is not selectable in production.
- The cloud-api adapter avoids Wrangler in CI while still exercising the real
  generated router, Worker entrypoint, container-control-plane forwarder, and
  DB-backed provisioning queue.
- No real cloud creds are needed; everything is local.
- Do not modify cloud-api / cloud-frontend source from inside this package.
  When a test exposes a real bug, surface it as a follow-up.
