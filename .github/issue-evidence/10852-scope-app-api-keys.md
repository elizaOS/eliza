# Issue #10852 Evidence: Scope App API Keys To Their Owning App

Date: 2026-07-01

## Change Summary

- Added `appApiKeyScopeMiddleware` in `packages/cloud/api/src/middleware/app-api-key-scope.ts`.
- Mounted it in `createApp()` immediately after the global auth gate and before generated routes.
- The middleware:
  - only inspects `/api/v1/apps/:uuid...` paths;
  - preserves no-key session/public traffic;
  - preserves unbound organization API keys;
  - reverse-resolves app-bound keys through `appsService.getByApiKeyId`;
  - returns `403 Invalid API key for this app` when an app key bound to App A targets App B.
- Extended app CRUD integration coverage so same-org sibling app keys cannot read, update, patch, or delete the sibling app.

## Verification

```bash
bunx biome check packages/cloud/api/src/middleware/app-api-key-scope.ts packages/cloud/api/src/bootstrap-app.ts packages/cloud/api/__tests__/app-api-key-scope.middleware.test.ts packages/cloud/api/__tests__/apps-crud.integration.test.ts
```

Result: passed.

```bash
bun test packages/cloud/api/__tests__/app-api-key-scope.middleware.test.ts packages/cloud/api/__tests__/apps-crud.integration.test.ts
```

Result: passed. 51 tests, 146 assertions.

Covered cases:

- app detail path extraction ignores collection helper paths such as `/api/v1/apps/check-name`;
- no-key requests pass through without service lookups;
- invalid keys are left to route auth;
- unbound org keys retain org-wide access;
- the owning app key is allowed;
- a sibling app key is denied with 403;
- same-org sibling app key attempts do not mutate/delete target app state.

## Typecheck

```bash
bun run --cwd packages/cloud/api typecheck
```

Result: blocked by the local linked dependency tree:

```text
error TS2688: Cannot find type definition file for '@cloudflare/workers-types'.
```

## Artifacts Marked N/A

- UI screenshots/video: N/A, backend auth middleware only.
- Real LLM trajectories: N/A, no model-backed behavior changed.
- DB migration up/down evidence: N/A, no schema or migration changes.
- Billing/usage records: N/A, no billing calculation or ledger change.
