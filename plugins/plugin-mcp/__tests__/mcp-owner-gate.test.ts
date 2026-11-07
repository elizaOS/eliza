/**
 * The MCP action runs tools on servers the owner configured, with the owner's
 * server credentials. The real action gate and planned-tool executor admit it
 * for the owner and refuse it before the handler for every other role. The
 * provider that lists the servers' tools is shown to the owner only.
 */
import {
  canActionRun,
  executePlannedToolCall,
  filterProvidersByContextGate,
  type Memory,
} from "@elizaos/core";
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
  for (const registered of mcpPlugin.actions ?? []) runtime.registerAction(registered);
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

    // Without supplied roles the executor resolves them from the message: a
    // stranger is refused on the promoted call_tool action too.
    const stranger = await executePlannedToolCall(
      runtime,
      { message, activeContexts: ["general"] as const },
      { name: "MCP_CALL_TOOL", params }
    );
    expect(stranger.success).toBe(false);
    expect(callTool).not.toHaveBeenCalled();

    // The agent's own turn resolves to OWNER.
    const owner = {
      message: { ...message, entityId: runtime.agentId },
      activeContexts: ["general"] as const,
    };
    expect(canActionRun(mcpAction, { ...owner, userRoles: ["OWNER"] })).toBe(true);
    await executePlannedToolCall(runtime, owner, { name: "MCP_CALL_TOOL", params });
    expect(callTool).toHaveBeenCalledWith("files", "read_file", { path: "~/.ssh/config" });

    // The server and tool list reaches only the owner's prompt.
    const providers = mcpPlugin.providers ?? [];
    for (const role of ["GUEST", "USER", "ADMIN"] as const) {
      expect(filterProvidersByContextGate(providers, ["connectors"], [role]), role).toEqual([]);
    }
    expect(
      filterProvidersByContextGate(providers, ["connectors"], ["OWNER"]).map((p) => p.name)
    ).toEqual(["MCP"]);
  } finally {
    await runtime.stop();
  }
});
