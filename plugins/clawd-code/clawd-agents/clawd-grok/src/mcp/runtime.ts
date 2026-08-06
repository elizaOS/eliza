import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "../utils/settings";
import { validateMcpServerConfig } from "./validate";

function mcpToolPrefix(server: McpServerConfig): string {
  return `mcp_${server.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function toTransport(server: McpServerConfig) {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      stderr: "pipe",
    });
  }

  return {
    type: server.transport,
    url: server.url ?? "",
    headers: server.headers,
  } as const;
}

export interface McpToolBundle {
  tools: ToolSet;
  errors: string[];
  close(): Promise<void>;
}

export async function buildMcpToolSet(servers: McpServerConfig[]): Promise<McpToolBundle> {
  const tools: ToolSet = {};
  const errors: string[] = [];
  const clients: MCPClient[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;

    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      errors.push(`${server.label}: ${validation.error}`);
      continue;
    }

    try {
      const client = await createMCPClient({
        transport: toTransport(server),
        name: `clawd-${server.id}`,
        version: "1.0.0",
      });
      clients.push(client);

      const mcpTools = await client.tools();
      const prefix = mcpToolPrefix(server);

      for (const [name, tool] of Object.entries(mcpTools)) {
        const prefixedName = `${prefix}__${name}`;
        tools[prefixedName] = {
          ...tool,
          description: `[MCP ${server.label}] ${tool.description ?? name}`,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${server.label}: ${message}`);
    }
  }

  return {
    tools,
    errors,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
