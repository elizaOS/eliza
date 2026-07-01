# Issue #10621 - Payout assumed-operational production guard

## Change proven

Production now fails closed when `PAYOUT_STATUS_ASSUME_OPERATIONAL=1` is present. The flag remains available for local/staging e2e stacks, but production payout status does not report networks as available and the redemption token-availability check refuses to proceed.

## Manual review

Reviewed the issue body on GitHub and the cloud money-path files:

- `packages/cloud/shared/src/lib/services/payout-status.ts`
- `packages/cloud/shared/src/lib/services/token-redemption-secure.ts`
- `packages/cloud/shared/src/lib/config/deployment-environment.ts`
- `packages/cloud/shared/src/lib/services/cloudflare-registrar.ts`
- `packages/cloud/api/v1/apps/[id]/domains/buy/route.ts`
- `packages/cloud/api/cron/process-redemptions/route.ts`

Existing Cloudflare registrar dev-stub production guard was already present. This patch closes the analogous payout-status assumption path.

## Verification

```bash
bun install
```

Result: passed after rebasing onto latest `origin/develop` (`Checked 4839 installs across 5073 packages (no changes)`).

```bash
bun test --coverage-reporter=lcov --coverage-dir=.tmp/coverage-10621 \
  packages/cloud/shared/src/lib/config/deployment-environment.test.ts \
  packages/cloud/shared/src/lib/services/__tests__/payout-status-resilience.test.ts
```

Result: passed (`11 pass`, `0 fail`, `30 expect() calls`, `Ran 11 tests across 2 files`).

```bash
bun x biome check \
  packages/cloud/shared/src/lib/config/deployment-environment.ts \
  packages/cloud/shared/src/lib/config/deployment-environment.test.ts \
  packages/cloud/shared/src/lib/services/payout-status.ts \
  packages/cloud/shared/src/lib/services/token-redemption-secure.ts \
  packages/cloud/shared/src/lib/services/__tests__/payout-status-resilience.test.ts
```

Result: passed (`Checked 5 files`).

```bash
bun run --cwd packages/cloud/shared typecheck
```

Result: passed (`tsgo --noEmit`).

```bash
bun run verify
```

Result: passed on the rebased branch:

- Turbo typecheck/lint/build graph: `474 successful, 474 total`
- Audit checks: build/typecheck model, turbo build deps, TEE secret leak, and scripts all passed
- `typecheck:dist`: `checked 28 dist-path consumer config(s)`
- Process exit: `0`

After that full verify, `origin/develop` advanced by one app-smoke-only commit
(`2f9f76fcc98`). Rebased cleanly onto it, reran `bun install`, and reran the
focused cloud checks above on the final synced branch:

- `bun run --cwd packages/cloud/shared typecheck`: passed
- `bun x biome check ...`: passed (`Checked 5 files`)
- focused `bun test ...`: passed (`11 pass`, `0 fail`, `30 expect() calls`)

## Evidence applicability

- Backend logs: covered by test output showing `[PayoutStatus] Refusing assumed-operational payout status in production`.
- DB/domain artifacts: N/A for this guard; it prevents the request from reaching money-moving or DB-mutating payout paths.
- UI screenshots/video: N/A; no UI changed.
- Real LLM trajectory: N/A; no model/action/provider behavior changed.
- Native/audio artifacts: N/A; no native/audio surface changed.

## Operator-only items still requiring secrets/infra

Issue #10621 also tracks owner-only actions that cannot be completed from this local branch: production image digest pinning, provisioning daemon secrets/arming, and the full-chain staging e2e with staging `TEST_API_KEY` plus provider keys.
