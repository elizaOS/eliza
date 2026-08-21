/** Exercises compatibility-safe MCP pricing serialization at discovery. */

import { describe, expect, test } from "bun:test";
import { serializeLegacyMcpCreditPricing } from "./pricing";

describe("discovery MCP pricing", () => {
  test("keeps the legacy point amount and adds canonical USD", () => {
    expect(serializeLegacyMcpCreditPricing("1.25")).toEqual({
      type: "credits",
      amount: 1.25,
      amountUsd: 0.0125,
      amountUnit: "legacy_mcp_pricing_points",
      currency: "USD",
      description: "$0.0125 in cloud credit per request",
    });
  });

  test("fails closed on a corrupt stored amount", () => {
    expect(() => serializeLegacyMcpCreditPricing("not-a-number")).toThrow(
      RangeError,
    );
  });
});
