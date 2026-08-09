/**
 * Classify a failed join-flow error as the Cloud's insufficient-credits gate
 * (HTTP 402, canonical body from `insufficientCredits402` server-side) so the
 * /join surface can render a first-class "add funds" state instead of the raw
 * transport message.
 *
 * WHY this matters: a brand-new signup whose welcome bonus was withheld by the
 * anti-sybil per-IP daily grant cap (CGNAT: dorm/office/mobile networks) lands
 * on /join with $0 and the agent-create call 402s. Without classification the
 * page shows "Cloud request failed (402): ..." under "Couldn't connect to your
 * agent" with a Retry button that can never succeed — a genuine user reads
 * that as a broken app. The server's 402 body carries the real explanation
 * (`welcomeBonusWithheld` + a friendly message); surface it and route the user
 * to billing.
 *
 * Error shapes handled (both walk the `cause` chain):
 *  - `ApiError` from the client fetch path: `status`, `code`, message = body.error.
 *  - The direct-cloud request error: `status` + the parsed JSON body on `data`.
 */

export interface JoinCreditGateError {
  /** The server's user-facing explanation (the 402 body's `error`). */
  message: string;
  /** True when the body says the signup welcome bonus was withheld (IP cap). */
  welcomeBonusWithheld: boolean;
}

const INSUFFICIENT_CREDITS_CODE = "insufficient_credits";

function bodyFrom(error: Error): Record<string, unknown> | null {
  const data = (error as Error & { data?: unknown }).data;
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * The credit-gate classification for a join failure, or `null` when the error
 * is anything else (network, provisioning, auth, ...). Fail-closed: unless the
 * shape is provably the canonical 402 gate body, callers keep the generic
 * error state.
 */
export function describeJoinCreditGateError(
  error: unknown,
): JoinCreditGateError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const { status, code } = current as Error & {
      status?: unknown;
      code?: unknown;
    };
    const body = bodyFrom(current);
    const bodyCode = body?.code;
    if (
      status === 402 ||
      code === INSUFFICIENT_CREDITS_CODE ||
      bodyCode === INSUFFICIENT_CREDITS_CODE
    ) {
      const bodyError =
        typeof body?.error === "string" ? body.error.trim() : "";
      const message = bodyError || current.message.trim();
      return {
        message,
        welcomeBonusWithheld: body?.welcomeBonusWithheld === true,
      };
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}
