# cloud-e2e runbook

Operational guide for the mock-backed Playwright suite. Architecture is in
[`/docs/cloud-mock-stack.md`](../../docs/cloud-mock-stack.md); this doc is
about running and debugging.

## Run locally

From the repo root:

```bash
bun run cloud:e2e
```

This boots the full stack (PGlite TCP bridge, Hetzner mock, control-plane mock,
cloud-api wrangler dev, cloud-frontend Vite dev) inside the Playwright worker
fixture (`packages/cloud-e2e/src/fixtures/stack.ts`), then runs every spec
under `packages/cloud-e2e/tests/`. Wall time: roughly 3–6 minutes on a warm
machine — most of that is the first cloud-api boot (migrations + wrangler dev
startup); subsequent specs in the same worker reuse the running stack.

Reset cached state between runs:

```bash
bun run cloud:local:reset
```

> TODO: confirm `scripts/cloud/local-reset.mjs` exists once the parallel agent
> lands it — the npm script is wired in `package.json:165` but the script
> file was not present in this branch at doc-writing time.

## Debug a failing spec

Run a single spec file:

```bash
bun run --cwd packages/cloud-e2e test -- tests/provision.spec.ts
```

Run a single test by name:

```bash
bun run --cwd packages/cloud-e2e test -- -g "provisions a sandbox"
```

Run headed (visible Chromium window):

```bash
bun run cloud:e2e:headed
```

Run with the Playwright UI (time travel, DOM snapshot per step):

```bash
bun run cloud:e2e:ui
```

## Inspect mock state

Each subprocess streams stdout/stderr to `packages/cloud-e2e/.logs/`:

- `cloud-api.log` — wrangler dev + migration output
- `cloud-frontend.log` — Vite dev output

Inside a spec, the stack handle exposes the live mock stores for direct
assertions (`stack.ts:45`):

```ts
test("...", async ({ stack }) => {
  const servers = [...stack.mocks.hetzner.store.servers.values()];
  const sandboxes = stack.mocks.controlPlane.store.allSandboxes();
  // ...
});
```

There is no dedicated REPL for mid-test inspection — drop a `console.log` of
the store snapshot or attach a Playwright `await page.pause()` and read the
fixture handle from the debugger.

## Common failures and fixes

**Port conflict on cloud-api or cloud-frontend.** All five ports are picked
fresh via `pickFreePort()` (`stack.ts:53`), so a true conflict is rare.
Symptom: `EADDRINUSE` in `.logs/cloud-api.log`. Cause: a previous wrangler dev
process did not get reaped — `killProc` only SIGTERMs the direct child.
Fix: `pkill -f wrangler` and retry. If recurring, audit the spawn tree.

**Migration timeout on cloud-api boot.** Symptom:
`[stack] cloud-api did not become healthy ... within 180000ms`. Cause:
`cloud-api-dev.mjs` is re-running migrations against a corrupt PGlite data
dir. Fix: `rm -rf packages/cloud-e2e/.logs` and any stale `cloud-e2e-*` dir
under `$TMPDIR` (the fixture mkdtemps a fresh one per run but interrupted runs
leave them behind), then re-run.

**Slow cloud-api boot (under 180s but flaky).** Symptom: intermittent timeout
on cold CI. Cause: wrangler resolving dependencies. Fix: bump the
`waitForHttpOk` timeout in `stack.ts:213` or pre-warm by running
`bun run --cwd packages/cloud-api build` once before the suite.

**Cron tick mistuned — sandbox stays in `provisioning`.** Symptom:
`provision.spec.ts` polls forever, sandbox never reaches `running`. Cause:
`CONTROL_PLANE_TICK_MS=0` was inherited from the shell and the background
tick was disabled (`control-plane/index.ts:50`). Fix: ensure
`CONTROL_PLANE_TICK_MS` is unset or `>0`, and verify the test is hitting
`tickProvisioning()` (`helpers/provisioning.ts:17`) if it relies on manual
ticking.

**Auth bypass not propagating to the page.** Symptom: `onboarding.spec.ts`
lands on the login screen instead of the dashboard. Cause:
`PLAYWRIGHT_TEST_AUTH=true` and `PLAYWRIGHT_TEST_AUTH_SECRET` did not reach
either the API or the frontend. Both subprocesses inherit env from
`buildSharedEnv` (`fixtures/env.ts:21`); confirm the secret matches the one
used to sign the cookie in `helpers/test-fixtures.ts:16`. The cookie name
is `eliza-test-session`.

**Hetzner mock unauthorized.** Symptom: control-plane provisioning job fails
with `hetzner create failed: 401`. Cause: `HCLOUD_TOKEN` empty or whitespace
(the mock's auth middleware in `hetzner/server.ts:33` rejects empty
bearers). Fix: set any non-empty string; e2e uses `test-token`.

## CI vs local differences

GitHub Actions (`.github/workflows/cloud-e2e.yml`) differs in:

- **Playwright browsers.** CI uses `actions/cache` keyed on
  `cloud-e2e/package.json` (`cloud-e2e.yml:42`). On cache miss it runs
  `bunx playwright install --with-deps chromium`; on hit it only installs
  system deps. Local runs assume browsers were installed once via
  `bunx playwright install chromium`.
- **Artifacts.** CI uploads `playwright-report/`, `test-results/`, and the
  full `.logs/` directory with 7-day retention (`cloud-e2e.yml:78`–`96`).
  Locally these live under `packages/cloud-e2e/` and are not cleaned
  automatically.
- **Job timeout.** CI caps the job at 30 minutes (`cloud-e2e.yml:29`).
- **`DATABASE_URL`.** CI sets `pglite://./.eliza-ci/.pgdata` as a placeholder
  so module-load doesn't crash; the fixture overrides it with the live TCP
  URL before any subprocess is spawned.
- **`NODE_OPTIONS=--max-old-space-size=4096`** is set in CI to keep
  wrangler + vite + Playwright comfortably under the runner ceiling.
