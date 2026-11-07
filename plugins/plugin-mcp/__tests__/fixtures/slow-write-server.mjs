import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// A write tool that commits its effect at once and answers after a delay, like
// a remote API that is slower than the client's request timeout.
const delayMs = Number(process.argv[2] ?? "0");
const calls = [];
const server = new Server(
  { name: "slow-write-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_issue",
      description: "Create an issue with the given title",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  calls.push({ name: params.name, arguments: params.arguments });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { content: [{ type: "text", text: `Created issue ${calls.length}` }] };
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
