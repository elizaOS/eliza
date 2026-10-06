/** Real stdio MCP peer for discovery, cursor failures, and subsequent execution. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const [mode, failingList] = process.argv.slice(2);
const requests = [];
const server = new Server(
  { name: "paginated-discovery-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

for (const [schema, key, item] of [
  [
    ListToolsRequestSchema,
    "tools",
    (n) => ({ name: `tool-${n}`, inputSchema: { type: "object" } }),
  ],
  [
    ListResourcesRequestSchema,
    "resources",
    (n) => ({ name: `resource-${n}`, uri: `fixture:///${n}` }),
  ],
  [
    ListResourceTemplatesRequestSchema,
    "resourceTemplates",
    (n) => ({
      name: `template-${n}`,
      uriTemplate: `fixture:///${n}/{id}`,
    }),
  ],
]) {
  server.setRequestHandler(schema, async (request) => {
    const cursor = request.params?.cursor;
    requests.push({ list: key, cursor: cursor ?? null });
    if (key === failingList && cursor !== undefined) {
      if (mode === "error") throw new McpError(ErrorCode.InternalError, "later page unavailable");
      if (mode === "repeat") return { [key]: [], nextCursor: cursor };
      if (mode === "cycle")
        return { [key]: [], nextCursor: cursor === "page B/+=" ? "" : "page B/+=" };
    }
    if (mode === "single") return { [key]: [item(0)] };
    if (mode === "empty") return { [key]: [] };
    if (cursor === undefined) return { [key]: [item(0)], nextCursor: "" };
    if (cursor === "") return { [key]: [], nextCursor: "page B/+=" };
    if (cursor === "page B/+=") return { [key]: [item(2)] };
    throw new McpError(ErrorCode.InvalidParams, "unexpected cursor");
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, requests }) }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, text: "last-page resource" }],
}));
await server.connect(new StdioServerTransport());
