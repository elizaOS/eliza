/** Serializes stored user-MCP prices without reinterpreting legacy fields. */

import {
  legacyMcpPointsToOrganizationCredits,
  ORGANIZATION_CREDIT_UNIT,
} from "@elizaos/cloud-shared/billing";

/** Preserve the legacy amount while adding an explicit canonical USD amount. */
export function serializeLegacyMcpCreditPricing(storedPoints: string | number) {
  const amount = Number(storedPoints);
  const amountUsd = legacyMcpPointsToOrganizationCredits(amount);
  return {
    type: "credits" as const,
    amount,
    amountUsd,
    amountUnit: "legacy_mcp_pricing_points" as const,
    currency: ORGANIZATION_CREDIT_UNIT,
    description: `$${amountUsd} in cloud credit per request`,
  };
}
