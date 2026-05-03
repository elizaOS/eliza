# QUALITY_AUDIT

## Scope
High-confidence try/catch cleanup pass focused on `api` first, with conservative changes only.

## Removed
1. `packages/api/src/services/waifu-bridge.ts`
   - Removed `try/catch` around `vault.createAgent(...)`.
   - Previous behavior only logged and re-threw the same error with no translation or fallback.
2. `packages/api/src/services/waifu-bridge.ts`
   - Removed `try/catch` around `vault.getBalance(...)` in `syncAgentBalance()`.
   - Previous behavior only logged and re-threw the same error with no added context.
3. `packages/api/src/index.ts`
   - Removed synchronous `try/catch` in `/ready` vault check.
   - The guarded code only inspected `process.env.STEWARD_MASTER_PASSWORD` and could not throw in normal execution.

## Deferred
Kept the following because they handle legitimate unknown input, third-party failures, or intentional fallbacks:
1. `packages/api/src/services/context.ts#verifySessionToken`
   - Invalid/expired JWTs should resolve to `null`, not crash auth middleware.
2. `packages/api/src/services/context.ts#safeJsonParse`
   - Handles unsanitized request JSON.
3. `packages/api/src/routes/auth.ts#verifySessionToken`
   - Same JWT-invalid-input case as above.
4. `packages/api/src/routes/auth.ts#safeJsonParse`
   - Handles unsanitized request JSON.
5. `packages/auth/src/session.ts#verifySession`
   - Invalid/tampered JWT input intentionally maps to `null`.
6. `packages/shared/src/price-oracle.ts#fetchPrice`
   - Third-party network call with intentional fallback to `null`.
7. `packages/api/src/routes/webhooks.ts#isValidUrl`
   - `new URL(url)` is parsing unsanitized user input.
8. `packages/api/src/routes/approvals.ts` BigInt parsing guard
   - Validates unsanitized numeric input from request body.
9. `packages/sdk/src/auth.ts#notifyListeners`
   - Listener isolation is intentional so consumer callbacks cannot break auth state transitions.

## Validation
- Reviewed diff manually.
- Did not run full test suite in this pass.

## Counts
- Removals: 3 try/catch blocks
- Deferred: 9 reviewed blocks kept intentionally
