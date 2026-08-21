/** Verifies the single MCP metadata authority used by routes and execution. */

import { describe, expect, test } from "vitest";
import { BUILTIN_MCP_PRICING, PLATFORM_MCP_TOOL_PRICING } from "./mcp-pricing";

describe("canonical MCP pricing metadata", () => {
  test("matches the actual fixed/free memory execution contract", () => {
    expect(PLATFORM_MCP_TOOL_PRICING).toEqual({
      save_memory: {
        billing: "fixed",
        priceUsd: 1,
        label: "$1 in cloud credit",
      },
      retrieve_memories: {
        billing: "free",
        priceUsd: 0,
        label: "Free",
      },
    });
  });

  test("keeps unmetered built-in transports free", () => {
    for (const pricing of [
      BUILTIN_MCP_PRICING.time,
      BUILTIN_MCP_PRICING.weather,
      BUILTIN_MCP_PRICING.crypto,
    ]) {
      expect(pricing).toMatchObject({
        type: "free",
        creditUnit: "USD",
        priceUsd: 0,
      });
      expect(pricing).not.toHaveProperty("pricePerRequest");
    }
  });
});
