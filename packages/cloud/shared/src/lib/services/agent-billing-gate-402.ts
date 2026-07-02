/**
 * Canonical 402 response for a failed agent credit gate.
 *
 * Companion to `checkAgentCreditGate` (./agent-billing-gate.ts). Every route
 * that denies on the gate serializes this one body, so the insufficient-credits
 * wire shape cannot drift between routes. Kept in its own module (type-only
 * import of the gate) so route unit tests that mock the db-backed gate module
 * still exercise the real body shape.
 */

import { AGENT_PRICING } from "../constants/agent-pricing";
import { logger } from "../utils/logger";
import type { CreditGateResult } from "./agent-billing-gate";

export interface InsufficientCreditsBody {
  success: false;
  code: "insufficient_credits";
  error: string;
  requiredBalance: number;
  currentBalance: number;
}

/** Build the canonical 402 body from a denied `checkAgentCreditGate` result. */
export function insufficientCreditsBody(
  creditCheck: Pick<CreditGateResult, "balance" | "error">,
): InsufficientCreditsBody {
  return {
    success: false,
    code: "insufficient_credits",
    error: creditCheck.error ?? "Insufficient credits",
    requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
    currentBalance: creditCheck.balance,
  };
}

/**
 * Warn with the route's log line (plus the gate numbers) and return the
 * canonical 402 body. Routes own the transport — Hono `c.json`,
 * `Response.json` + CORS headers — and must send it with status 402.
 */
export function insufficientCredits402(
  creditCheck: Pick<CreditGateResult, "balance" | "error">,
  warn: string,
  logContext: Record<string, unknown>,
): InsufficientCreditsBody {
  logger.warn(warn, {
    ...logContext,
    balance: creditCheck.balance,
    required: AGENT_PRICING.MINIMUM_DEPOSIT,
  });
  return insufficientCreditsBody(creditCheck);
}
