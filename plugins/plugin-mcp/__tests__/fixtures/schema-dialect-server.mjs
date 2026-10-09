import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const tuple = {
  type: "array",
  prefixItems: [{ type: "string" }, { type: "integer" }],
  items: false,
  minItems: 2,
  maxItems: 2,
};
const input = (dialect) => ({
  ...(dialect ? { $schema: dialect } : {}),
  $id: "https://fixture.invalid/shared-tool-schema",
  type: "object",
  properties: {
    pair: dialect?.includes("draft-07")
      ? { ...tuple, prefixItems: undefined, items: tuple.prefixItems, additionalItems: false }
      : tuple,
  },
  required: ["pair"],
  additionalProperties: false,
});
const schemas = {
  implicit: input(),
  explicit: input("https://json-schema.org/draft/2020-12/schema"),
  legacy: input("http://json-schema.org/draft-07/schema#"),
  unsupported: input("https://fixture.invalid/unsupported-dialect"),
};
const calls = [];
const server = new Server(
  { name: "schema-dialect-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(schemas).map(([name, inputSchema]) => ({
    name,
    description: "Return the supplied pair without changing its types",
    inputSchema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  calls.push({ name: params.name, arguments: params.arguments });
  return { content: [{ type: "text", text: JSON.stringify(calls.at(-1)) }] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "fixture:///calls", name: "Invocation receipt" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [
    { uri: "fixture:///calls", mimeType: "application/json", text: JSON.stringify(calls) },
  ],
}));
await server.connect(new StdioServerTransport());
