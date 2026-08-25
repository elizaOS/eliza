/**
 * Deterministic unit tests for handleMcpError and McpError helpers.
 * Exercises graceful handling of partial/malformed memory and state inputs.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleMcpError, McpError } from "../src/utils/error.js";

describe("handleMcpError", () => {
  it("handles standard error execution without callback", async () => {
    const runtime = {} as IAgentRuntime;
    const result = await handleMcpError(
      {} as State,
      {} as never,
      new Error("connection dropped"),
      runtime,
      { content: { text: "call tool" } } as Memory,
      "tool",
    );

    expect(result.success).toBe(false);
    expect(result.text).toBe("Failed to execute MCP tool");
    expect(result.data?.error).toBe("connection dropped");
  });

  it("handles nullish/malformed memory content when callback is supplied", async () => {
    const runtime = {
      useModel: vi.fn().mockResolvedValue("Helpful explanation"),
    } as unknown as IAgentRuntime;
    const callback = vi.fn();

    const result = await handleMcpError(
      {} as State,
      {} as never,
      "plain string error",
      runtime,
      { content: {} } as Memory,
      "resource",
      callback,
    );

    expect(result.success).toBe(false);
    expect(callback).toHaveBeenCalledWith({
      text: "Helpful explanation",
      actions: ["REPLY"],
    });
  });

  it("constructs typed McpError variants", () => {
    const err = McpError.connectionError("test-server", "timeout");
    expect(err.code).toBe("CONNECTION_ERROR");
    expect(err.message).toContain("test-server");
    expect(err.message).toContain("timeout");
  });
});
