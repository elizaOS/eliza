# Issue #11588 - Billing Request ID Dedupe

## Scope

- `POST /api/v1/chat/completions` now server-generates the billing request id.
- `POST /api/v1/embeddings` now server-generates the billing request id.
- The explicit `idempotency-key` retry path remains unchanged.

This prevents callers from pinning `x-request-id` across separate billed
requests and forcing collisions in billing/affiliate dedupe paths.

## Validation

- `bunx @biomejs/biome check --write packages/cloud/api/v1/chat/completions/route.ts packages/cloud/api/v1/embeddings/route.ts packages/cloud/api/__tests__/chat-completions-optimistic-billing.test.ts packages/cloud/api/__tests__/embeddings-optimistic-billing.test.ts`
- `bun test --coverage-reporter=lcov packages/cloud/api/__tests__/chat-completions-optimistic-billing.test.ts packages/cloud/api/__tests__/embeddings-optimistic-billing.test.ts` - 13 tests passed.

## N/A Evidence

- UI screenshots/video: N/A - backend billing request-id boundary only.
- Real LLM trajectories: N/A - route-level billing/idempotency behavior; no model prompt, provider, action, or agent trajectory changed.
- DB artifact: N/A for this slice - focused tests assert the pending-charge and settler receive the same server-generated request id and do not copy the client header.
