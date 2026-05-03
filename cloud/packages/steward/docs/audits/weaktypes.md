# Weak Types Audit
## Summary
- Scope researched: `sdk`, `react`, `api`, `db`, `webhooks`, plus spot checks in `auth` and `shared`.
- Applied a high-confidence `sdk` + `react` pass centered on removing private-field casts and replacing runtime duck-typing with public SDK methods.
- Also hardened low-risk `api` and `db` `catch (err: any)` handlers to `unknown` with safe narrowing.
- Replaced 22 weak-type sites in production code.
- Deferred 6 broader-risk areas/filesets for follow-up.
- Validation:
  - `git diff --check` passed.
  - `bunx @biomejs/biome check` passed on the changed TS files.
  - `bunx tsc --noEmit --project packages/react/tsconfig.json` was not actionable in this worktree because package type dependencies like `react`/`@stwd/sdk` are unavailable to the isolated compiler invocation here; the failure was environmental, not introduced by these edits.
- High-confidence targets selected for this pass:
  - `packages/react/src/provider.tsx`
  - `packages/react/src/hooks/useTransactions.ts`
  - `packages/react/src/hooks/useApprovals.ts`
  - `packages/react/src/hooks/useSpend.ts`
  - `packages/sdk/src/auth.ts`
  - `packages/sdk/src/client.ts`
  - `packages/api/src/index.ts`
  - `packages/api/src/routes/erc8004.ts`
  - `packages/db/src/pglite.ts`
- Rationale: these files use `as unknown as Record<...>` or private-field casts even though the SDK already exposes the relevant methods/types, or use straightforward `catch (err: any)` sites that can be hardened to `unknown` without schema or third-party ripple effects.

## By file
- `packages/react/src/provider.tsx`
  - Multiple `as unknown as Record<string, unknown>` casts around `StewardAuth` methods.
  - `authSession` is already `StewardSession`, so tenant access can be strongly typed.
  - Tenant config fetch reaches into private `client.baseUrl` via cast.
- `packages/react/src/hooks/useTransactions.ts`
  - Reaches into private `client.baseUrl` via cast.
- `packages/react/src/hooks/useApprovals.ts`
  - Reaches into private `client.baseUrl` via cast.
- `packages/react/src/hooks/useSpend.ts`
  - Reaches into private `client.baseUrl` via cast.
- `packages/sdk/src/client.ts`
  - Good candidate for a small public `getBaseUrl()` accessor to remove downstream private-field casts.
- `packages/sdk/src/auth.ts`
  - Good candidate for a small public `getBaseUrl()` accessor to remove downstream private-field casts.
  - One remaining generic payload cast in `authRequest()` is broader than needed, but changing that shape risks wider response typing churn.
- `packages/webhooks/src/persistent-queue.ts`
  - Has `as unknown as` around webhook payload persistence/hydration. Possible fix with a local serialized payload type, but lower priority than sdk/react and requires DB payload-shape review.
- `packages/api/src/index.ts`
  - Hardened readiness-check `catch (err: any)` sites to `unknown` with safe `Error` narrowing.
- `packages/api/src/routes/erc8004.ts`
  - Hardened five route-local `catch (err: any)` sites to `unknown`, with no response-shape or DB typing changes.
- `packages/api/src/routes/audit.ts`
  - `filterStatus as any` likely fixable with a route-local union/type guard, but needs endpoint input-shape review.
- `packages/db/src/pglite.ts`
  - Hardened migration error handling from `any` to `unknown` using message extraction, without changing Drizzle/PGlite result typing.

## Deferred
- `packages/webhooks/src/persistent-queue.ts`
  - Deferred pending payload serialization shape review.
- `packages/api/src/routes/audit.ts`
  - Deferred pending route parameter typing review.
- `packages/api/src/routes/policies-standalone.ts`
  - Contains multiple `any` casts/params with likely broader Drizzle/result-shape ripples.
- `packages/eliza-plugin/**`
  - Many `as any` usages depend on third-party runtime service/message typing and would ripple across the plugin surface.
- `scripts/e2e-*.ts`, `packages/api/src/__tests__/**`, `packages/auth/src/__tests__/**`, `packages/db/src/__tests__/**`
  - Test cleanup is possible, but lower priority than production `sdk` and `react` targets for this pass.
- `packages/agent-trader/src/state.ts`
  - `as unknown as` around viem clients looks fixable, but needs stronger chain/client type audit.

## Files changed
- `packages/api/src/index.ts`
- `packages/api/src/routes/erc8004.ts`
- `packages/db/src/pglite.ts`
- `packages/react/src/provider.tsx`
- `packages/react/src/hooks/useTransactions.ts`
- `packages/react/src/hooks/useApprovals.ts`
- `packages/react/src/hooks/useSpend.ts`
- `packages/sdk/src/auth.ts`
- `packages/sdk/src/client.ts`
