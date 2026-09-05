/** Projects transport-owned MCP servers into one lossless provider representation. */

import type {
  McpKernelProviderData,
  McpKernelProviderProjection,
  McpKernelServer,
} from "./protocol.js";

const NO_DESCRIPTION = "No description available";

export function buildMcpProviderProjection(
  servers: readonly McpKernelServer[],
): McpKernelProviderProjection {
  if (servers.length === 0) {
    return {
      values: { mcp: {} },
      data: { mcp: {} },
      text: "No MCP servers are currently connected.",
    };
  }

  const mcp: Record<string, McpKernelProviderData[string]> = {};
  const lines: string[] = ["# MCP Configuration", ""];

  for (const server of servers) {
    const tools: Record<
      string,
      { description: string; inputSchema?: Readonly<Record<string, unknown>> }
    > = {};
    const resources: Record<
      string,
      { name: string; description: string; mimeType?: string }
    > = {};
    lines.push(`## Server: ${server.name} (${server.status})`, "");

    if (server.tools?.length) {
      lines.push("### Tools:", "");
      for (const tool of server.tools) {
        const description = tool.description ?? NO_DESCRIPTION;
        tools[tool.name] = {
          description,
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        };
        lines.push(`- **${tool.name}**: ${description}`);
      }
      lines.push("");
    }

    if (server.resources?.length) {
      lines.push("### Resources:", "");
      for (const resource of server.resources) {
        const description = resource.description ?? NO_DESCRIPTION;
        resources[resource.uri] = {
          name: resource.name,
          description,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        };
        lines.push(`- **${resource.name}** (${resource.uri}): ${description}`);
      }
      lines.push("");
    }

    mcp[server.name] = { status: server.status, tools, resources };
  }

  const text = lines.join("\n");
  return { values: { mcp, mcpText: text }, data: { mcp }, text };
}

/** Compact prompt projection used by the local provider facade. */
export function formatMcpProviderForPrompt(
  data: McpKernelProviderData,
): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return "No MCP servers are available.";
  return [
    `mcpServers[${entries.length}]:`,
    ...entries.flatMap(([name, server]) => {
      const tools = Object.keys(server.tools);
      const resources = Object.keys(server.resources);
      return [
        `  - name: ${name}`,
        `    status: ${server.status}`,
        `    tools: ${tools.length ? tools.join(", ") : "none"}`,
        `    resources: ${resources.length ? resources.join(", ") : "none"}`,
      ];
    }),
  ].join("\n");
}
