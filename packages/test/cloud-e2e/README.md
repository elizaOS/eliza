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

### Real wallet login (no DB seeding)

`seedTestUser` inserts rows directly and never runs the login flow. To exercise
the REAL login path, use `loginWithTestWallet(stack.urls.api)`
(`src/helpers/wallet-login.ts`): it runs the genuine SIWE handshake
(nonce → sign with a throwaway viem wallet → verify) against the booted cloud-api
and returns a real API key for a free account. The stack runs the worker with
`MOCK_REDIS=1` (shared in-process store), so the SIWE nonce survives between the
two requests. `asSeededUser(login)` adapts the result to the `SeededUser` shape.

The same flow is available as a dev/CI gate: `bun run cloud:login:test-wallet`
(defaults to `https://api.elizacloud.ai`; pass `--base <url>` for a local stack).
It exits non-zero if login or the authenticated probe fails.

**The `seededUser` fixture now uses this real path for every spec.** Instead of
inserting rows directly, it calls `loginAsSeededUser(stack.urls.api)`, which runs
the genuine SIWE handshake and then elevates the fresh wallet account to the
suite's privileged baseline (admin role, funded org, known verified email) via a
direct DB update — exactly the end-state `seedTestUser` produced. So every spec
that consumes `seededUser` authenticates with a credential the real login flow
minted, with no other changes. `seedTestUser` is kept for specs that need extra
secondary identities (attacker / other-user / end-user).

## Specs

| File                          | Covers                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `tests/siwe-login.spec.ts`    | real nonce → sign → verify mints a usable key; forged sig 401s; re-login is idempotent; fixture identity is real-login-minted |
| `tests/dashboard.spec.ts`     | seeded user reaches dashboard with test-auth session, localStorage writable   |
| `tests/provision.spec.ts`     | create agent → cron tick → sandbox `running`, control-plane sees the sandbox  |
| `tests/deprovision.spec.ts`   | DELETE agent → async `agent_delete` job → polls to `deleted` / 404            |
| `tests/stuck-cleanup.spec.ts` | aged `provisioning` row with no job → cleanup cron → sandbox `error`          |
| `tests/domain-purchase-harness.spec.ts` | harness-logic verification for the money-gated domain-purchase lane against the registrar dev stub: full chain, price ceiling, ledger, 402/409/502-refund/idempotency negatives |
| `tests/domain-purchase.real.spec.ts` | **money-gated LIVE lane (#10691)** — real Cloudflare registration + credit debit; skips loudly unless `ELIZA_LIVE_DOMAIN_PURCHASE=1` + base URL + key are set. Operator runbook: [docs/domain-purchase-live.md](docs/domain-purchase-live.md) |

## Live domain purchase (real money, operator-gated)

`tests/domain-purchase.real.spec.ts` buys a real cheap-TLD domain (≤ 500¢
ceiling, enforced BEFORE buying) against staging/prod, proves it goes active
and serves, and appends every attempt to the append-only purchase ledger
(`domain-purchase-ledger/ledger.jsonl`, inspect with
`bun run domains:ledger`). CI never runs it — the whole suite honest-skips
unless the operator sets the money guard. Command, env matrix, ledger and
cleanup semantics: [docs/domain-purchase-live.md](docs/domain-purchase-live.md).

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
