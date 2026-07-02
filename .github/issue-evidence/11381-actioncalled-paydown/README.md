# #11381 Action-Effect Ratchet Paydown Evidence

## Scope

- Added effect-proving final checks to a first slice of actionCalled-only
  scenarios across keyless connector/status domains.
- Lowered `packages/scenario-runner/src/action-effect-ratchet.test.ts`
  `BASELINE` from `60` to `42`, matching the current static corpus count.

## Local validation

- Static ratchet-count script using the same AST logic as
  `action-effect-ratchet.test.ts`: `count = 42`.
- `bun run --cwd packages/scenario-runner test -- src/action-effect-ratchet.test.ts`
- `git diff --check origin/develop...HEAD`

## Remaining debt

- 42 direct scenarios remain actionCalled-only and are listed by the static
  ratchet logic. This PR is a ratcheted paydown slice, not full closure of
  #11381.
