/**
 * Join-flow interpretation of the Cloud's insufficient-credits gate so the
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
 * The 402 recognition itself (status/code match, cause-chain walk, fail-closed
 * default) is the domain-neutral `describeCreditGateError` in `api/`; this
 * wrapper only adds the join-owned welcome-bonus reading of the body.
 */

import { describeCreditGateError } from "../../../api/credit-gate-error";

export interface JoinCreditGateError {
  /** The server's user-facing explanation (the 402 body's `error`). */
  message: string;
  /** True when the body says the signup welcome bonus was withheld (IP cap). */
  welcomeBonusWithheld: boolean;
  /** Server-authored reason used for reason-specific explanatory UI. */
  welcomeBonusWithheldReason?: "ip_daily_cap" | "count_unavailable";
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
  const gate = describeCreditGateError(error);
  if (!gate) return null;
  const reason = gate.body?.welcomeBonusWithheldReason;
  return {
    message: gate.message,
    welcomeBonusWithheld: gate.body?.welcomeBonusWithheld === true,
    ...(reason === "ip_daily_cap" || reason === "count_unavailable"
      ? { welcomeBonusWithheldReason: reason }
      : {}),
  };
}
