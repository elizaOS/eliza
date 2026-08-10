/** Verifies that the personal Google connector advertises MCP draft creation without a false delivery rail. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createGoogleConnectorContribution } from "./google.js";

describe("Google personal connector", () => {
  it("does not expose send when Gmail MCP can only create drafts", () => {
    const connector = createGoogleConnectorContribution({
      agentId: "agent-google-mcp-draft",
    } as IAgentRuntime);

    expect(connector.capabilities).toContain("google.gmail.draft.create");
    expect(connector.capabilities).not.toContain("google.gmail.send");
    expect(connector.send).toBeUndefined();
    expect(connector.receiptContract).toBeUndefined();
    expect(connector.requiresApproval).toBeUndefined();
  });
});
