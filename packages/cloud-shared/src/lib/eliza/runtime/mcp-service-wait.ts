import { type AgentRuntime, elizaLogger, type Plugin } from "@elizaos/core";

type McpService = {
  waitForInitialization?: () => Promise<void>;
  getServers?: () => unknown[];
};

export async function waitForMcpServiceIfNeeded(
  runtime: AgentRuntime,
  plugins: Plugin[],
): Promise<void> {
  if (!plugins.some((p) => p.name === "mcp")) return;

  const startTime = Date.now();
  const maxWaitMs = 15000;
  const maxDelay = 200;
  let waitMs = 5;
  let mcpService = runtime.getService("mcp") as McpService | null;

  while (!mcpService && Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, waitMs));
    mcpService = runtime.getService("mcp") as McpService | null;
    waitMs = Math.min(waitMs * 2, maxDelay);
  }

  const elapsed = Date.now() - startTime;
  if (!mcpService) {
    elizaLogger.warn(`[RuntimeFactory] MCP service not available after ${elapsed}ms`);
    return;
  }

  elizaLogger.debug(`[RuntimeFactory] MCP service found in ${elapsed}ms`);

  if (typeof mcpService.waitForInitialization === "function") {
    await mcpService.waitForInitialization();
  }

  const servers = mcpService.getServers?.();
  if (servers) {
    elizaLogger.info(
      `[RuntimeFactory] MCP: ${servers.length} server(s) connected in ${Date.now() - startTime}ms`,
    );
    for (const server of servers as Array<{
      name: string;
      status: string;
      tools?: unknown[];
      error?: string;
    }>) {
      elizaLogger.info(
        `[RuntimeFactory] MCP Server: ${server.name} status=${server.status} tools=${server.tools?.length || 0} error=${server.error || "none"}`,
      );
    }
  }
}
