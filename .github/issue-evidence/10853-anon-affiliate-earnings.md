# 10853 Anonymous Affiliate Earnings Evidence

Issue: https://github.com/elizaOS/eliza/issues/10853

## What Was Verified

- Anonymous `/api/v1/chat` requests still use the free-tier anonymous reservation path.
- `X-Affiliate-Code` is no longer forwarded into `billUsage()` for anonymous requests whose reservation is a no-op.
- Authenticated org-backed `/api/v1/chat` requests still keep the affiliate-code billing path.
- The regression test drives the real Hono route through `streamText.onFinish()` and asserts anonymous billing receives `affiliateCode: null`.

## Commands Run

```bash
bunx biome check --write packages/cloud/api/v1/chat/route.ts packages/cloud/api/__tests__/chat-stream-credit-leak.test.ts
bun test packages/cloud/api/__tests__/chat-stream-credit-leak.test.ts
rg -n "affiliateCode" packages/cloud/api/v1/chat/route.ts packages/cloud/api/__tests__/chat-stream-credit-leak.test.ts
bun run --cwd packages/cloud/api typecheck
```

## Results Reviewed

- Biome: 2 files checked, no fixes needed after final pass.
- Focused `/v1/chat` suite: 5 tests passed, including the new anonymous affiliate-code regression.
- Source grep: route now derives `affiliateCode` from `requestedAffiliateCode` only when the caller is non-anonymous and org-backed; the regression assertion checks `affiliateCode: null` for anonymous billing.
- `packages/cloud/api` typecheck: blocked by local dependency install missing `@cloudflare/workers-types`.

## Evidence N/A / Deferred

- UI screenshots/video: N/A, no UI changed.
- Migration up/down and DB rows: N/A, no schema or migration changed.
- Live Cloud request trace: not captured in this local pass because no live Cloud billing credentials/model keys were configured. The route-level test exercises the relevant onFinish billing path deterministically.
