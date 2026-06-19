import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function registerTypedTool<TArgs extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: TArgs) => Promise<TextToolResult>,
): void {
  const tool = server.tool as unknown as (
    toolName: string,
    toolDescription: string,
    toolInputSchema: Record<string, unknown>,
    toolHandler: (args: TArgs) => Promise<TextToolResult>,
  ) => void;
  tool.call(server, name, description, inputSchema, handler);
}
