# Issue #11795 - /v1/messages conversion refund gap

## Scope

`POST /api/v1/messages` reserved credits and created a reservation settler, then
converted Anthropic request payload fields (`messages`, `tools`, `tool_choice`,
safe model params) before entering the `try` block whose `catch` refunds with
`settleReservation(0)`.

`convertTools` can throw while converting a malformed tool schema. Before this
fix, that throw could happen after reservation and before the refunding catch,
stranding the debit.

## Fix

Moved all post-reserve payload conversion into the existing refunding `try`
block in `packages/cloud/api/v1/messages/route.ts`.

## Validation

- `bun test packages/cloud/api/__tests__/messages-iac-fast-path.test.ts`
  - 4 pass / 0 fail.
  - New route-level regression forces tool schema conversion to throw after
    `reserveCredits` and `createCreditReservationSettler`; it asserts
    `settleReservation(0)` is called exactly once and the provider is never
    invoked.
- `bun run --cwd packages/cloud/api typecheck` - passed.
- `bunx @biomejs/biome check packages/cloud/api/__tests__/messages-iac-fast-path.test.ts packages/cloud/api/v1/messages/route.ts` - passed.
- `git diff --check` - passed.

## Not Captured

- Live provider trajectory: N/A - this regression is a pre-provider conversion
  failure path; the test asserts the provider is not called.
- Screenshots/video: N/A - backend money-path fix, no UI.
