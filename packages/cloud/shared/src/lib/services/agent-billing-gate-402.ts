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

/**
 * Build the canonical 402 body from a denied `checkAgentCreditGate` result.
 *
 * The withheld-welcome-bonus reason comes from the route's explicit `context`
 * (the create-with-signup route that just ran the grant) OR from the gate
 * result itself — `checkAgentCreditGate` reads the reason recorded on the
 * org's settings at signup, so EVERY gate-denying route (create, provision,
 * resume, wake, upgrade) explains a capped signup without per-route plumbing.
 */
export function insufficientCreditsBody(
  creditCheck: Pick<
    CreditGateResult,
    "balance" | "error" | "welcomeBonusWithheldReason" | "welcomeBonusWithheldMessage"
  >,
  context: InsufficientCreditsContext = {},
): InsufficientCreditsBody {
  const withheldReason =
    context.welcomeBonusWithheldReason ?? creditCheck.welcomeBonusWithheldReason;
  const withheldMessage =
    context.welcomeBonusWithheldMessage ?? creditCheck.welcomeBonusWithheldMessage;
  // `<= 0`: a withheld-bonus org has never held funds, so zero is the expected
  // shape, but a negative reconciliation must not flip the explanation back to
  // the generic copy while the reason is attached.
  const welcomeBonusWithheld = withheldReason && creditCheck.balance <= 0;
  return {
    success: false,
    code: "insufficient_credits",
    error: welcomeBonusWithheld
      ? (withheldMessage ??
        "Welcome credit unavailable for this signup. Add funds to start an agent.")
      : (creditCheck.error ?? "Insufficient credits"),
    requiredBalance: context.requiredBalance ?? AGENT_PRICING.MINIMUM_DEPOSIT,
    currentBalance: creditCheck.balance,
    ...(welcomeBonusWithheld
      ? {
          welcomeBonusWithheld: true,
          welcomeBonusWithheldReason: withheldReason,
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
  creditCheck: Pick<
    CreditGateResult,
    "balance" | "error" | "welcomeBonusWithheldReason" | "welcomeBonusWithheldMessage"
  >,
  warn: string,
  logContext: Record<string, unknown>,
  context: InsufficientCreditsContext = {},
): InsufficientCreditsBody {
  const withheldReason =
    context.welcomeBonusWithheldReason ?? creditCheck.welcomeBonusWithheldReason;
  logger.warn(warn, {
    ...logContext,
    balance: creditCheck.balance,
    required: context.requiredBalance ?? AGENT_PRICING.MINIMUM_DEPOSIT,
    ...(withheldReason ? { welcomeBonusWithheldReason: withheldReason } : {}),
  });
  return insufficientCreditsBody(creditCheck, context);
}
