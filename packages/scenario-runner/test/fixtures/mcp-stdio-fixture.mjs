/**
 * Standalone stdio MCP server used as a fixture by the MCP scenarios: exposes a
 * deterministic echo tool and a fixed resource over the Model Context Protocol
 * stdio transport. The optional JSONL receipt records the real SDK request,
 * response, and child lifecycle boundary for scenario evidence and orphan checks.
 */
import { appendFileSync } from "node:fs";

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
const receiptPath = process.env.SCENARIO_MCP_RECEIPT_PATH;
let stopped = false;

function receipt(direction, method, payload = {}) {
  if (!receiptPath) return;
  appendFileSync(
    receiptPath,
    `${JSON.stringify({ direction, method, payload, pid: process.pid })}\n`,
    "utf8",
  );
}

function recordStop(reason) {
  if (stopped) return;
  stopped = true;
  receipt("lifecycle", "stopped", { reason });
}

receipt("lifecycle", "started");
process.once("SIGTERM", () => {
  recordStop("SIGTERM");
  process.exit(0);
});
process.once("SIGINT", () => {
  recordStop("SIGINT");
  process.exit(0);
});
process.once("exit", () => recordStop("exit"));

const server = new Server(
  { name: "scenario-mcp", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  receipt("request", "tools/list", request.params);
  const response = {
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
  };
  receipt("response", "tools/list", response);
  return response;
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  receipt("request", "tools/call", request.params);
  const response = {
    content: [
      {
        type: "text",
        text: `mcp-tool-echo:${request.params.arguments?.code ?? ""}`,
      },
    ],
  };
  receipt("response", "tools/call", response);
  return response;
});

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  receipt("request", "resources/list", request.params);
  const response = {
    resources: [
      {
        uri: RESOURCE_URI,
        name: "Deterministic MCP Note",
        description: "Deterministic scenario resource.",
        mimeType: "text/plain",
      },
    ],
  };
  receipt("response", "resources/list", response);
  return response;
});

server.setRequestHandler(
  ListResourceTemplatesRequestSchema,
  async (request) => {
    receipt("request", "resources/templates/list", request.params);
    const response = { resourceTemplates: [] };
    receipt("response", "resources/templates/list", response);
    return response;
  },
);

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  receipt("request", "resources/read", request.params);
  const response = {
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: "text/plain",
        text: RESOURCE_TEXT,
      },
    ],
  };
  receipt("response", "resources/read", response);
  return response;
});

await server.connect(new StdioServerTransport());
