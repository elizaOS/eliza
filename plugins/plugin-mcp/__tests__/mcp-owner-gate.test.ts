/**
 * The MCP action runs tools on servers the owner configured, with the owner's
 * server credentials. The real action gate and planned-tool executor admit it
 * for the owner and refuse it before the handler for every other role.
 */
import { canActionRun, executePlannedToolCall, type Memory } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { mcpAction } from "../src/actions/mcp";
import mcpPlugin from "../src/index";
import { MCP_SERVICE_NAME } from "../src/types";

it("runs an MCP tool for the owner and refuses every other role before the tool call", async () => {
  const runtime = createSQLiteTestRuntime({
    character: { name: "MCP owner gate", bio: [] },
    logLevel: "fatal",
  });
  await runtime.initialize();
  const callTool = vi.fn(async () => ({
    content: [{ type: "text", text: "file contents" }],
    isError: false,
  }));
  const server = {
    name: "files",
    status: "connected",
    config: { type: "stdio", command: "files-server" },
    tools: [{ name: "read_file", inputSchema: { type: "object" } }],
    resources: [],
  };
  const mcpService = {
    getServers: () => [server],
    getProviderData: () => ({ values: { mcp: {} }, data: { mcp: {} }, text: "" }),
    callTool,
  };
  const originalGetService = runtime.getService.bind(runtime);
  vi.spyOn(runtime, "getService").mockImplementation(
    (name) => (name === MCP_SERVICE_NAME ? mcpService : originalGetService(name)) as never
  );
  runtime.registerAction(mcpAction);
  const message = {
    id: crypto.randomUUID(),
    agentId: runtime.agentId,
    entityId: crypto.randomUUID(),
    roomId: runtime.agentId,
    content: { text: "read ~/.ssh/config with the files server", source: "test" },
  } as Memory;
  const params = {
    action: "call_tool",
    serverName: "files",
    toolName: "read_file",
    arguments: { path: "~/.ssh/config" },
  };

  try {
    for (const role of ["GUEST", "USER", "ADMIN"] as const) {
      const context = { message, userRoles: [role], activeContexts: ["general"] as const };
      expect(canActionRun(mcpAction, context), role).toBe(false);
      const result = await executePlannedToolCall(runtime, context, {
        name: mcpAction.name,
        params,
      });
      expect(result.success, role).toBe(false);
    }
    expect(callTool).not.toHaveBeenCalled();
    // Every action the plugin registers (the umbrella and its promoted
    // call_tool / read_resource actions) carries the same gate.
    for (const registered of mcpPlugin.actions ?? []) {
      const context = {
        message,
        userRoles: ["USER"] as const,
        activeContexts: ["general"] as const,
      };
      expect(canActionRun(registered, context), registered.name).toBe(false);
    }

    // The executor resolves the caller's role from the message; the agent's own
    // turn resolves to OWNER.
    const owner = {
      message: { ...message, entityId: runtime.agentId },
      userRoles: ["OWNER"] as const,
      activeContexts: ["general"] as const,
    };
    expect(canActionRun(mcpAction, owner)).toBe(true);
    await executePlannedToolCall(runtime, owner, { name: mcpAction.name, params });
    expect(callTool).toHaveBeenCalledWith("files", "read_file", { path: "~/.ssh/config" });
  } finally {
    await runtime.stop();
  }
});
