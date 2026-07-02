# Accounts-UI e2e — multi-account rotation pool (#10722 / #11032)

Real-browser, real-network, real-API, real-disk e2e for the dashboard's
multi-account surface (`AccountList` and friends).

## What is real

| Layer | Implementation |
| --- | --- |
| Browser | Playwright headless Chromium — real DOM, real events |
| UI | The REAL `packages/ui/src/components/accounts/*` tree (`AccountList`, `AccountCard`, `AddAccountDialog`, `RotationStrategyPicker`, `EditableAccountLabel`), the real `useAccounts` hook, and the real `ElizaClient` network layer, esbuild-bundled with the real Tailwind theme |
| Network | Same-origin `fetch` from the browser into a live HTTP server |
| API | The REAL `handleAccountsRoutes` from `packages/agent/src/api/accounts-routes.ts` — same zod schemas, same handlers the dashboard server mounts |
| Pool | The REAL default `AccountPool` from `packages/app-core/src/services/account-pool.ts` (pinned to source via `tsconfig.e2e-paths.json` so a stale `dist` can never stand in for the current tree) |
| Storage | The REAL on-disk credential store + `_pool-metadata.json` overlay under a scratch `ELIZA_HOME` |

The only stubs: the app-state barrel (translator-only —
`accounts-fixture-state-stub.ts`) and browser stubs for Node built-ins, both
mirroring the established `packages/ui/src/**/__e2e__` harness pattern. Health
states are seeded through the pool's REAL mutation APIs (`markRateLimited`,
`markNeedsReauth`) — the same calls the runtime makes on an upstream 429/401 —
via the server's `/__e2e__/*` control surface.

## Run

```bash
node packages/app/e2e/accounts-ui/run-accounts-ui-e2e.mjs
```

Requires `bun` on PATH and Playwright's Chromium installed. Ports: the API
server binds 34110 (scans up through 34139; override with
`ACCOUNTS_E2E_PORT`).

Screenshots, frontend console/network logs, backend server logs, and the
assertion transcript land in
`.github/issue-evidence/10722-accounts-ui-e2e/`. Exit code is non-zero on any
failed assertion or page error.

## Covered scenarios

1. Empty state (no accounts connected).
2. Add dialog; invalid API key (< 8 chars) rejected by the real server-side
   zod validation with the error surfaced inline.
3. Add two api-key accounts (POST → 201) — credential files verified on disk.
4. Priority reorder via move-up (two sequential PATCHes) — swap verified in
   the DOM, the pool, and the metadata overlay.
5. Rotation strategy change (PATCH `/api/providers/:id/strategy`) —
   persisted through `saveConfig`.
6. Health/rotation status display: rate-limited (with reset countdown) and
   needs-reauth badges rendered from real pool state.
7. Enabled toggle (PATCH `enabled=false`).
8. Delete with confirm dialog (DELETE) — credential + metadata removed from
   disk; empty state returns after the last account is removed.
9. Mobile viewport (390x844) capture of the populated health states.
10. Zero page errors across the whole flow.

Companion service-level coverage (same workstream) lives in
`packages/app-core/src/services/multi-account-affinity-failover.test.ts` and
`packages/app-core/test/services/multi-account-upstream-429-failover.test.ts`.
