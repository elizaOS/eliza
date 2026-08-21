/** Deterministic tests for both reviewed DoorDash MCP tool dialects. */

import { describe, expect, it } from "vitest";
import {
  buildToolArguments,
  callDoorDashOperation,
  hasDoorDashCapability,
} from "./adapter.js";
import type { DoorDashMcpService, DoorDashToolResult } from "./types.js";

function service(
  tools: string[],
  result: DoorDashToolResult = {
    content: [{ type: "text", text: '{"success":true}' }],
  },
): DoorDashMcpService & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    getServers: () => [
      {
        name: "doordash",
        status: "connected",
        tools: tools.map((name) => ({ name })),
      },
    ],
    callTool: async (serverName, toolName, toolArguments) => {
      calls.push({ serverName, toolName, toolArguments });
      return result;
    },
  };
}

describe("DoorDash MCP adapter", () => {
  it("maps search to the Strider tool dialect", async () => {
    const mcp = service(["doordash_search"]);
    await callDoorDashOperation(mcp, "search", {
      query: "ramen",
      cuisine: "Japanese",
    });
    expect(mcp.calls).toEqual([
      {
        serverName: "doordash",
        toolName: "doordash_search",
        toolArguments: { query: "ramen", cuisine: "Japanese" },
      },
    ]);
  });

  it("maps item IDs and minor-unit price to the GraphQL tool dialect", () => {
    expect(
      buildToolArguments("add_to_cart", "add_to_cart", {
        restaurantId: "store-1",
        menuId: "menu-1",
        itemId: "item-1",
        itemName: "Miso ramen",
        unitPrice: 1599,
        quantity: 2,
      }),
    ).toEqual({
      storeId: "store-1",
      menuId: "menu-1",
      itemId: "item-1",
      itemName: "Miso ramen",
      unitPrice: 1599,
      quantity: 2,
      currency: "USD",
    });
  });

  it("does not advertise a disconnected or unrelated server", () => {
    const mcp: DoorDashMcpService = {
      getServers: () => [
        {
          name: "doordash",
          status: "error",
          tools: [{ name: "doordash_search" }],
        },
        { name: "other", status: "connected", tools: [{ name: "search" }] },
      ],
      callTool: async () => ({ content: [] }),
    };
    expect(hasDoorDashCapability(mcp)).toBe(false);
  });

  it("fails closed when an MCP result reports success false without isError", async () => {
    const mcp = service(["doordash_search"], {
      content: [{ type: "text", text: '{"success":false,"error":"expired"}' }],
    });
    await expect(
      callDoorDashOperation(mcp, "search", { query: "pizza" }),
    ).rejects.toMatchObject({
      code: "DOORDASH_ADAPTER_ERROR",
    });
  });
});
