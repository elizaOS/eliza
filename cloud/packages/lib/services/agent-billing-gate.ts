/**
 * Agent billing gate — pre-provisioning credit check.
 *
 * Ensures an organization has more than the minimum running balance before
 * allowing agent creation, provisioning, or resume.
 */

import { organizationsRepository } from "@/db/repositories";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { logger } from "@/lib/utils/logger";

export interface CreditGateResult {
  allowed: boolean;
  balance: number;
  error?: string;
}

/**
 * Check whether an organization has sufficient credits for Eliza agent operations.
 *
 * Returns `{ allowed: true }` if `credit_balance > MINIMUM_DEPOSIT`,
 * otherwise returns a user-facing error message directing them to add funds.
 */
export async function checkAgentCreditGate(organizationId: string): Promise<CreditGateResult> {
  try {
    const org = await organizationsRepository.findById(organizationId);
    if (!org) {
      return {
        allowed: false,
        balance: 0,
        error: "Organization not found",
      };
    }

    const balance = Number(org.credit_balance);

    if (balance <= AGENT_PRICING.MINIMUM_DEPOSIT) {
      const deficit = Math.max(AGENT_PRICING.MINIMUM_DEPOSIT - balance, 0.01);
      return {
        allowed: false,
        balance,
        error: `Insufficient credits. A balance greater than $${AGENT_PRICING.MINIMUM_DEPOSIT.toFixed(2)} is required to create or run Eliza agents. Please add at least $${deficit.toFixed(2)} to your account at /dashboard/billing.`,
      };
    }

    return { allowed: true, balance };
  } catch (error) {
    logger.error("[agent-billing-gate] Failed to check credits", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — don't allow provisioning if we can't verify credits
    return {
      allowed: false,
      balance: 0,
      error: "Unable to verify credit balance. Please try again.",
    };
  }
}
