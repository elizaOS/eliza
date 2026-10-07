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
  PingRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const [mode, failingList] = process.argv.slice(2);
const requests = [];
const capabilityMode = ["resources-only", "tools-only", "no-capabilities"].includes(mode);
const capabilities = capabilityMode
  ? {
      ...(mode === "tools-only" ? { tools: {} } : {}),
      ...(mode === "resources-only" ? { resources: {} } : {}),
    }
  : { tools: {}, resources: {} };
const server = new Server(
  { name: "paginated-discovery-fixture", version: "1.0.0" },
  { capabilities }
);
server.setRequestHandler(PingRequestSchema, async () => {
  requests.push({ list: "ping", cursor: null });
  if (failingList === "ping-error") throw new McpError(ErrorCode.InternalError, "ping unavailable");
  if (failingList === "ping-timeout") return new Promise(() => {});
  return {};
});

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
  if (key === "tools" ? !capabilities.tools : !capabilities.resources) continue;
  server.setRequestHandler(schema, async (request) => {
    const cursor = request.params?.cursor;
    if (mode === "crash-list" && key === "tools" && cursor === undefined) {
      process.exit(1);
    }
    if (mode === "slow-list" && key === "tools" && cursor === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    requests.push({ list: key, cursor: cursor ?? null });
    if (key === failingList && mode === "sticky-empty") return { [key]: [item(0)], nextCursor: "" };
    if (key === failingList && mode === "endless")
      return { [key]: [], nextCursor: `page-${requests.length}` };
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

if (capabilities.tools) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (mode.startsWith("result-")) {
      const content = [];
      if (mode === "result-mixed" || mode === "result-text")
        content.push({ type: "text", text: "Text summary from the tool" });
      if (mode === "result-echo" || mode === "result-echo-spaced") {
        const json = JSON.stringify(request.params.arguments, null, mode === "result-echo" ? 0 : 2);
        content.push({ type: "text", text: mode === "result-echo" ? json : ` \n${json}\n ` });
      }
      if (mode === "result-mixed")
        content.push({ type: "image", mimeType: "image/png", data: "AAAA" });
      return {
        content,
        ...(mode === "result-text" ? {} : { structuredContent: request.params.arguments }),
        ...(mode === "result-error" ? { isError: true } : {}),
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ tool: request.params.name, requests }) }],
    };
  });
}
if (capabilities.resources) {
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (mode === "slow-read") await new Promise((resolve) => setTimeout(resolve, 400));
    if (mode === "resource-error")
      throw new McpError(ErrorCode.InvalidParams, "Resource unavailable");
    if (mode === "resource-multi") {
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
      contents: [
        {
          uri: request.params.uri,
          text:
            mode === "resource-empty"
              ? ""
              : capabilityMode
                ? JSON.stringify({ resource: request.params.uri, requests })
                : "last-page resource",
        },
      ],
    };
  });
}
await server.connect(new StdioServerTransport());
