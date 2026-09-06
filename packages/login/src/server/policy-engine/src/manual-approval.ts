/**
 * Engine-internal "route to manual approval" signal.
 *
 * The public `PolicyResult` (in `@stwd/shared`) only distinguishes pass/fail.
 * Some evaluators need a third outcome: "this policy did not pass, but the
 * transaction should be queued for human review rather than hard-rejected."
 * Reputation-threshold's `require-approval` action is the canonical case.
 *
 * We express that as an OPTIONAL boolean flag layered on top of `PolicyResult`.
 * Because the property is optional and JSON-serialisable, a result carrying it
 * is structurally still a `PolicyResult`: it flows through `EvaluationResult.
 * results`, audit events, and persistence without any schema change, and code
 * that ignores the flag simply sees a normal failed policy.
 *
 * IMPORTANT (fail-closed contract): the flag is ONLY meaningful when
 * `passed === false`. A passing result never needs manual approval, and the
 * engine must never treat a *hard* failure (block, default-deny, missing
 * inputs, unknown policy type) as "needs manual approval" just because some
 * other policy requested it. The engine therefore routes to manual approval
 * only when EVERY non-passing hard policy explicitly carries the flag (see
 * `engine.ts`). Absence of the flag means hard deny.
 */
export interface ManualApprovalSignal {
  /**
   * When `true` (and the result did not pass), the engine routes the
   * transaction to the manual-approval queue instead of hard-rejecting it.
   * Only honoured for non-`auto-approve-threshold` ("hard") policies; ignored
   * on passing results.
   */
  requiresManualApproval?: boolean;
}

/**
 * Read the manual-approval signal off any policy result. Returns `true` only
 * for a non-passing result that explicitly opted into manual review. Passing
 * results and plain failures both return `false`, so callers fail closed.
 */
export function resultRequiresManualApproval(
  result: { passed: boolean } & ManualApprovalSignal,
): boolean {
  return result.passed === false && result.requiresManualApproval === true;
}
