/**
 * Standalone stdio MCP server used as a fixture by the MCP scenarios: exposes a
 * deterministic echo tool and a fixed resource over the Model Context Protocol
 * stdio transport. Spawned as a child process so plugin-mcp connects to a real
 * server rather than a mock.
 */
const sdkRoot = new URL(
  "../../../../plugins/plugin-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/",
  import.meta.url,
);
const { Server } = await import(new URL("server/index.js", sdkRoot).href);
const { StdioServerTransport } = await import(
  new URL("server/stdio.js", sdkRoot).href
);
const {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} = await import(new URL("types.js", sdkRoot).href);

const RESOURCE_URI = "fixture://mcp-note";
const RESOURCE_TEXT = "mcp-resource-note:alpha-42";

const server = new Server(
  { name: "scenario-mcp", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_code",
      description: "Echo a deterministic code string.",
      inputSchema: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [
    {
      type: "text",
      text: `mcp-tool-echo:${request.params.arguments?.code ?? ""}`,
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: RESOURCE_URI,
      name: "Deterministic MCP Note",
      description: "Deterministic scenario resource.",
      mimeType: "text/plain",
    },
  ],
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));

server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [
    {
      uri: RESOURCE_URI,
      mimeType: "text/plain",
      text: RESOURCE_TEXT,
    },
  ],
}));

await server.connect(new StdioServerTransport());
