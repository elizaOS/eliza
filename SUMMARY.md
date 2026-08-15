# Zero-delivery recovery fix

## Finding

The recovery gate treated any non-empty `actionResults` array as evidence that real work occurred. Failed actions therefore enabled the acknowledgement fallback and could produce the misleading text `on it, working on that now.`

`ActionResult` uses its boolean `success` field as the authoritative execution outcome throughout `message.ts` (for example, media delivery already ignores results where `success` is false). Error detail is carried in result data in relevant execution paths, so absence of an error value is not as reliable as an explicit successful outcome.

## Change

Replaced the non-empty-array check with:

```typescript
actionResults.some((result) => result.success === true)
```

The existing `suppressesPlannerReply` condition remains unchanged and continues to take precedence.

## Tests and verification

- Added `zero-delivery-recovery.test.ts` with the four requested `bun:test` cases: all failed, successful, empty, and mixed results.
- Added `verify-zero-delivery.mjs`, a dependency-free Node harness covering those cases and planner-reply suppression.
- `node repo/verify-zero-delivery.mjs` passes.
- Bun is not installed in the cleanroom, so the `bun:test` suite could not be executed here.
