/** Exercises compatibility-safe MCP pricing serialization at discovery. */

import { describe, expect, test } from "bun:test";
import { serializeLegacyMcpCreditPricing } from "./pricing";

describe("discovery MCP pricing", () => {
  test("keeps the legacy point amount and adds canonical USD", () => {
    expect(serializeLegacyMcpCreditPricing("1.25")).toEqual({
      type: "credits",
      priceAvailable: true,
      amount: 1.25,
      amountUsd: 0.0125,
      amountUnit: "legacy_mcp_pricing_points",
      currency: "USD",
      description: "$0.0125 in cloud credit per request",
    });
  });

  test("quantizes a fractional point price instead of emitting a float remainder", () => {
    const pricing = serializeLegacyMcpCreditPricing("1.1");
    expect(pricing.amountUsd).toBe(0.011);
    expect(pricing.description).toBe("$0.011 in cloud credit per request");
  });

  test("treats a missing stored price as unavailable, never as free", () => {
    expect(serializeLegacyMcpCreditPricing(null)).toMatchObject({
      priceAvailable: false,
      description: "Price unavailable",
    });
    expect(serializeLegacyMcpCreditPricing(null).amountUsd).toBeUndefined();
  });

  test("degrades a corrupt stored amount to an explicit unavailable price", () => {
    const pricing = serializeLegacyMcpCreditPricing("not-a-number", {
      mcpId: "mcp-corrupt",
    });
    expect(pricing).toEqual({
      type: "credits",
      priceAvailable: false,
      amountUnit: "legacy_mcp_pricing_points",
      currency: "USD",
      description: "Price unavailable",
    });
    expect(pricing.amountUsd).toBeUndefined();
  });
});
