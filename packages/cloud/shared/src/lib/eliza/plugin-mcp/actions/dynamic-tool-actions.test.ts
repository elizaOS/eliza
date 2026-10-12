import type { IAgentRuntime, Memory } from "@elizaos/core"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it, vi } from "vitest"
import { createMcpToolAction } from "./dynamic-tool-actions"

describe("MCP dynamic action parameter boundary", () => {
  it("does not call the service for an optional null rejected by JSON Schema", async () => {
    const callTool = vi.fn()
    const runtime = {
      getService: () => ({ callTool }),
    } as unknown as IAgentRuntime
    const tool = {
      name: "set-mode",
      inputSchema: {
        type: "object",
        properties: { mode: { type: "string" } },
      },
    } as Tool
    const action = createMcpToolAction("demo", tool, new Set())
    const message = {
      content: { actionParams: { mode: null } },
    } as Memory

    const result = await action.handler(runtime, message, undefined, undefined)

    expect(result.success).toBe(false)
    expect(result.error).toContain("does not accept null")
    expect(callTool).not.toHaveBeenCalled()
  })
})
