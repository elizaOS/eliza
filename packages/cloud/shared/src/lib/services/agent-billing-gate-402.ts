/**
 * Canonical 402 response for a failed agent credit gate.
 *
 * Companion to `checkAgentCreditGate`. Every route that denies on the gate
 * serializes this one body so the insufficient-credits wire shape cannot drift
 * between routes.
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
