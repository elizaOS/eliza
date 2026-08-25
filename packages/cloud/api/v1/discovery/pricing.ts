/**
 * Serializes stored user-MCP prices for the public discovery listing.
 *
 * Discovery reads rows written by older code paths, so a stored
 * `credits_per_request` is untrusted input here. A corrupt value degrades that
 * single row to an explicit unavailable price rather than failing the whole
 * listing, and a valid value is quantized so no float remainder reaches the
 * public description.
 */

import {
  formatOrganizationCreditUsd,
  legacyMcpPointsToOrganizationCredits,
  ORGANIZATION_CREDIT_UNIT,
} from "@elizaos/cloud-shared/billing";
import { logger } from "@/lib/utils/logger";

export interface LegacyMcpCreditPricing {
  type: "credits";
  /** False when the stored price could not be interpreted; no amount is shown. */
  priceAvailable: boolean;
  /** @deprecated Legacy cent-like MCP pricing points; 100 points equal $1. */
  amount?: number;
  /** Canonical USD cloud-credit amount. */
  amountUsd?: number;
  amountUnit: "legacy_mcp_pricing_points";
  currency: typeof ORGANIZATION_CREDIT_UNIT;
  description: string;
}

/** Preserve the legacy amount while adding an explicit canonical USD amount. */
export function serializeLegacyMcpCreditPricing(
  storedPoints: string | number | null | undefined,
  context?: { mcpId?: string },
): LegacyMcpCreditPricing {
  // A null column is a missing price, never a free one: Number(null) is 0 and
  // would advertise a paid MCP at $0.
  const amount =
    storedPoints === null || storedPoints === undefined
      ? Number.NaN
      : Number(storedPoints);
  try {
    const amountUsd = legacyMcpPointsToOrganizationCredits(amount);
    return {
      type: "credits",
      priceAvailable: true,
      amount,
      amountUsd,
      amountUnit: "legacy_mcp_pricing_points",
      currency: ORGANIZATION_CREDIT_UNIT,
      description: `$${formatOrganizationCreditUsd(amountUsd)} in cloud credit per request`,
    };
  } catch (error) {
    // error-policy:J3 untrusted stored price; one corrupt row becomes an
    // explicit unavailable price instead of a fake $0 or a failed listing.
    logger.warn("[discovery] unusable stored MCP credit price", {
      mcpId: context?.mcpId,
      storedPoints: String(storedPoints),
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      type: "credits",
      priceAvailable: false,
      amountUnit: "legacy_mcp_pricing_points",
      currency: ORGANIZATION_CREDIT_UNIT,
      description: "Price unavailable",
    };
  }
}
