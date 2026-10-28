// A real stdio MCP server whose tool schema is the shape FastMCP/pydantic v2
// emit for `Optional[Union[str, int]] = None`: a mixed `anyOf` union that also
// carries `default`. Note search returns what it received, so a caller can see
// whether the model's arguments survived the round trip.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const searchNotesSchema = {
  type: "object",
  properties: {
    query: {
      anyOf: [{ type: "string" }, { type: "integer" }],
      title: "Query",
      description: "Search text, or the numeric id of one note.",
    },
    limit: {
      anyOf: [{ type: "string" }, { type: "integer" }],
      default: null,
      title: "Limit",
      description: "Maximum notes to return, or the string 'all'.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const server = new Server(
  { name: "union-argument-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_notes",
      description: "Search the saved notes and return the arguments that arrived.",
      inputSchema: searchNotesSchema,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: "text", text: `searched: ${JSON.stringify(params.arguments)}` }],
}));

await server.connect(new StdioServerTransport());
