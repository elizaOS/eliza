/**
 * MCP server wiring for computer-use (#9170 — optional MCP server seam).
 *
 * Builds an MCP server that exposes {@link COMPUTERUSE_MCP_TOOLS} so an external
 * MCP client can drive this machine. The `@modelcontextprotocol/sdk` is an
 * OPTIONAL dependency (declared in package.json `optionalDependencies`) — it is
 * imported dynamically so the plugin builds/loads without it; only operators who
 * actually run the MCP server need it installed. The pure catalog + dispatch in
 * `tools.ts` carry the logic and are unit-tested; this file is the thin transport
 * glue.
 */

import {
  COMPUTERUSE_MCP_TOOLS,
  type ComputerUseCommandRunner,
  dispatchComputerUseMcpTool,
} from "./tools.js";

/** The subset of the MCP SDK `McpServer` we use (locally typed so this file
 * type-checks whether or not the optional SDK is installed). */
interface McpServerLike {
  registerTool(
    name: string,
    config: {
      description?: string;
      inputSchema?: Record<string, unknown>;
    },
    handler: (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
}

function toInputSchema(
  tool: (typeof COMPUTERUSE_MCP_TOOLS)[number],
): Record<string, unknown> {
  return {
    type: "object",
    properties: tool.properties,
    ...(tool.required && tool.required.length > 0
      ? { required: tool.required }
      : {}),
  };
}

/**
 * Create an MCP server exposing the computer-use tools, dispatching each call to
 * `runner.executeCommand`. Dynamically imports the SDK; throws a clear error if
 * the optional dependency is not installed.
 */
export async function createComputerUseMcpServer(
  runner: ComputerUseCommandRunner,
  options: { name?: string; version?: string } = {},
): Promise<McpServerLike> {
  let McpServer: new (info: { name: string; version: string }) => McpServerLike;
  try {
    // Optional dependency — resolved at runtime only when the server is used.
    // Indirect specifier so the type-checker/bundler doesn't hard-require the
    // optional package at build time.
    const serverSpec = "@modelcontextprotocol/sdk/server/mcp.js";
    const mod = (await import(serverSpec)) as {
      McpServer: new (info: { name: string; version: string }) => McpServerLike;
    };
    McpServer = mod.McpServer;
  } catch (err) {
    throw new Error(
      "@modelcontextprotocol/sdk is required to run the computer-use MCP server. " +
        `Install it (it is an optional dependency): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  const server = new McpServer({
    name: options.name ?? "elizaos-computeruse",
    version: options.version ?? "1.0.0",
  });

  for (const tool of COMPUTERUSE_MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: toInputSchema(tool) },
      async (args: Record<string, unknown>) => {
        const result = await dispatchComputerUseMcpTool(
          runner,
          tool.name,
          args ?? {},
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }

  return server;
}

/**
 * Connect the server over stdio (for `claude_desktop_config.json` style
 * launches). Dynamically imports the stdio transport from the optional SDK.
 */
export async function connectComputerUseMcpStdio(
  runner: ComputerUseCommandRunner,
): Promise<McpServerLike> {
  const server = await createComputerUseMcpServer(runner);
  const stdioSpec = "@modelcontextprotocol/sdk/server/stdio.js";
  const { StdioServerTransport } = (await import(stdioSpec)) as {
    StdioServerTransport: new () => unknown;
  };
  await server.connect(new StdioServerTransport());
  return server;
}
