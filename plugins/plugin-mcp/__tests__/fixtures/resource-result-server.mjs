import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2];
const server = new Server(
  { name: "resource-result-peer", version: "1.0.0" },
  { capabilities: { resources: {} } }
);
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "fixture:///2", name: "Context for a later action" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (mode === "error") throw new McpError(ErrorCode.InvalidParams, "Resource unavailable");
  if (mode === "multi") {
    return {
      contents: [
        { uri: request.params.uri, mimeType: "text/plain", text: "完整资料\n".repeat(1000) },
        {
          uri: "fixture:///appendix",
          mimeType: "text/plain",
          text: "\n最后一项：成都，批次7312。",
        },
      ],
    };
  }
  return {
    contents: [{ uri: request.params.uri, text: mode === "empty" ? "" : "last-page resource" }],
  };
});
await server.connect(new StdioServerTransport());
