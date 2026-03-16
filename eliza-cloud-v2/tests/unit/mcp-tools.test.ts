/**
 * MCP Tools Registration Tests
 * Verifies all tools register without import/config errors
 */

import { describe, test, expect } from "bun:test";

describe("MCP Tools Registration", () => {
  test("getMcpHandler initializes without errors", async () => {
    const { getMcpHandler } = await import("@/app/api/mcp/route");
    const handler = await getMcpHandler();
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
  });

  test("all tool modules import without errors", async () => {
    // This catches import errors, missing dependencies, syntax errors
    const tools = await import("@/app/api/mcp/tools");

    expect(tools.registerCreditTools).toBeDefined();
    expect(tools.registerApiKeyTools).toBeDefined();
    expect(tools.registerGenerationTools).toBeDefined();
    expect(tools.registerMemoryTools).toBeDefined();
    expect(tools.registerConversationTools).toBeDefined();
    expect(tools.registerAgentTools).toBeDefined();
    expect(tools.registerContainerTools).toBeDefined();
    expect(tools.registerMcpTools).toBeDefined();
    expect(tools.registerRoomTools).toBeDefined();
    expect(tools.registerUserTools).toBeDefined();
    expect(tools.registerKnowledgeTools).toBeDefined();
    expect(tools.registerRedemptionTools).toBeDefined();
    expect(tools.registerAnalyticsTools).toBeDefined();
    expect(tools.registerGoogleTools).toBeDefined();
  });

  test("lib modules import without errors", async () => {
    const lib = await import("@/app/api/mcp/lib");

    expect(lib.jsonResponse).toBeDefined();
    expect(lib.errorResponse).toBeDefined();
    expect(lib.getAuthContext).toBeDefined();
    expect(lib.authContextStorage).toBeDefined();
  });
});
