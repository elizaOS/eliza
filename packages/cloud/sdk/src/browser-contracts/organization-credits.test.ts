/**
 * Pins the browser-safe organization-credit contracts (#22963). Public browser
 * packages (packages/ui) import these values directly, so the exported surface
 * must change deliberately: this suite fails when an export is dropped/renamed
 * or when the checkout-bounds object stops being a frozen, browser-safe
 * literal. Deterministic harness — pure module assertions, no collaborators.
 */
import { describe, expect, test } from "bun:test";
import {
  ORGANIZATION_CREDIT_CHECKOUT_LIMITS as reExportedLimits,
  ORGANIZATION_CREDIT_PRICING as reExportedPricing,
} from "@elizaos/cloud-shared/billing";
import * as browserContracts from "./organization-credits.js";

describe("organization-credit browser contracts (#22963)", () => {
  test("publishes the canonical one-off checkout bounds as a frozen literal", () => {
    expect(browserContracts.ORGANIZATION_CREDIT_CHECKOUT_LIMITS).toEqual({
      minAmountUsd: 1,
      maxAmountUsd: 1000,
    });
    expect(
      Object.isFrozen(browserContracts.ORGANIZATION_CREDIT_CHECKOUT_LIMITS),
    ).toBe(true);
  });

  test("the checkout bounds are browser-safe plain values", () => {
    // Browser consumers import this module without any server runtime; the
    // bounds must serialize to exactly their literal shape (no getters,
    // prototypes, or class instances smuggled in).
    const raw = JSON.parse(
      JSON.stringify(browserContracts.ORGANIZATION_CREDIT_CHECKOUT_LIMITS),
    );
    expect(raw).toEqual({ minAmountUsd: 1, maxAmountUsd: 1000 });
    expect(Object.keys(raw).sort()).toEqual(["maxAmountUsd", "minAmountUsd"]);
  });

  test("sdk browser-contract and cloud-shared re-export are the same object", () => {
    // The server seams enforce the values through the cloud-shared re-export;
    // if the two surfaces ever drift, one half of the system would validate a
    // different range than the other half advertises (#22963).
    expect(reExportedLimits).toBe(
      browserContracts.ORGANIZATION_CREDIT_CHECKOUT_LIMITS,
    );
    expect(reExportedPricing).toBe(
      browserContracts.ORGANIZATION_CREDIT_PRICING,
    );
  });

  test("keeps the frozen browser-contract export surface stable", () => {
    // Any change here changes what public browser packages can import; fail
    // loudly so a rename is a deliberate contract revision, not drift.
    expect(Object.keys(browserContracts).sort()).toEqual(
      [
        "LEGACY_MCP_POINTS_FRACTION_DIGITS",
        "LEGACY_MCP_POINTS_PER_DOLLAR",
        "ORGANIZATION_CREDIT_CHECKOUT_LIMITS",
        "ORGANIZATION_CREDIT_PRICING",
        "ORGANIZATION_CREDIT_UNIT",
        "ORGANIZATION_CREDIT_USD_PRECISION",
        "ORGANIZATION_CREDITS_PER_DOLLAR",
        "RETRIEVE_MEMORIES_PRICE_USD",
        "SAVE_MEMORY_PRICE_USD",
        "USD_PER_ORGANIZATION_CREDIT",
        "checkoutAmountUsdToCents",
        "formatOrganizationCreditUsd",
        "legacyMcpPointsToOrganizationCredits",
        "mcpUsageChargeReceiptFromLegacyPoints",
        "organizationCreditsToLegacyMcpPoints",
        "quantizeOrganizationCreditUsd",
      ].sort(),
    );
  });
});
