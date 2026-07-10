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
import type { SignupGrantWithheldReason } from "./signup-grant-guard";

export interface InsufficientCreditsBody {
  success: false;
  code: "insufficient_credits";
  error: string;
  requiredBalance: number;
  currentBalance: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
}

export interface InsufficientCreditsContext {
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
  /**
   * Threshold the denied gate enforced. Defaults to the create/provision/resume
   * minimum (`MINIMUM_DEPOSIT`); the shared→dedicated tier-upgrade gate passes
   * its N-days-of-hosting minimum so clients render the real number (#15355).
   */
  requiredBalance?: number;
}

/** Build the canonical 402 body from a denied `checkAgentCreditGate` result. */
export function insufficientCreditsBody(
  creditCheck: Pick<CreditGateResult, "balance" | "error">,
  context: InsufficientCreditsContext = {},
): InsufficientCreditsBody {
  const welcomeBonusWithheld = context.welcomeBonusWithheldReason && creditCheck.balance === 0;
  return {
    success: false,
    code: "insufficient_credits",
    error: welcomeBonusWithheld
      ? (context.welcomeBonusWithheldMessage ??
        "Welcome credit unavailable for this signup. Add funds to start an agent.")
      : (creditCheck.error ?? "Insufficient credits"),
    requiredBalance: context.requiredBalance ?? AGENT_PRICING.MINIMUM_DEPOSIT,
    currentBalance: creditCheck.balance,
    ...(welcomeBonusWithheld
      ? {
          welcomeBonusWithheld: true,
          welcomeBonusWithheldReason: context.welcomeBonusWithheldReason,
        }
      : {}),
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
  context: InsufficientCreditsContext = {},
): InsufficientCreditsBody {
  logger.warn(warn, {
    ...logContext,
    balance: creditCheck.balance,
    required: context.requiredBalance ?? AGENT_PRICING.MINIMUM_DEPOSIT,
    ...(context.welcomeBonusWithheldReason
      ? { welcomeBonusWithheldReason: context.welcomeBonusWithheldReason }
      : {}),
  });
  return insufficientCreditsBody(creditCheck, context);
}
