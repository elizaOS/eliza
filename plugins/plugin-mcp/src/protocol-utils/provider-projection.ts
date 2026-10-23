/** Projects transport-owned MCP servers into one lossless provider representation. */

import type {
  McpKernelProviderData,
  McpKernelProviderProjection,
  McpKernelServer,
} from "./protocol.js";

const NO_DESCRIPTION = "No description available";

/**
 * A dictionary keyed by a server-supplied name. On a plain object the literal
 * name `__proto__` is applied to the prototype instead of stored, so a server
 * or tool the server really listed would have no own key. The own-key lookups
 * that guard model-supplied names would then reject it, and the prototype of
 * the dictionary would be server data. A null prototype stores every name as
 * an own data property.
 */
function nameDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function buildMcpProviderProjection(
  servers: readonly McpKernelServer[]
): McpKernelProviderProjection {
  if (servers.length === 0) {
    const mcp = nameDictionary<McpKernelProviderData[string]>();
    return {
      values: { mcp },
      data: { mcp },
      text: "No MCP servers are currently connected.",
    };
  }

  const mcp = nameDictionary<McpKernelProviderData[string]>();
  const lines: string[] = ["# MCP Configuration", ""];

  for (const server of servers) {
    const tools = nameDictionary<{
      description: string;
      inputSchema?: Readonly<Record<string, unknown>>;
    }>();
    const resources = nameDictionary<{
      name: string;
      description: string;
      mimeType?: string;
    }>();
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
export function formatMcpProviderForPrompt(data: McpKernelProviderData): string {
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
