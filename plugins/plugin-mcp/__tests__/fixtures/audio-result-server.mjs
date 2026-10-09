import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2] ?? "only";
const wav = Buffer.alloc(44 + 1600);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(1600, 40);
for (let n = 0; n < 800; n++)
  wav.writeInt16LE(Math.round(6000 * Math.sin((n * Math.PI * 2 * 440) / 8000)), 44 + n * 2);
const audio = { type: "audio", mimeType: "audio/wav", data: wav.toString("base64") };
const image = {
  type: "image",
  mimeType: "image/gif",
  data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};
const server = new Server(
  { name: "audio-result-reproduction", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "sample", description: "Return an audio attachment", inputSchema: { type: "object" } },
  ],
}));
const resources = [image, audio, image].map((item, index) => ({
  uri: `fixture:///media/${index}`,
  mimeType: item.mimeType,
  blob: item.data,
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "fixture:///media", name: "Binary resources" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: resources }));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content:
    mode === "binary"
      ? resources.map((resource) => ({ type: "resource", resource }))
      : mode === "only"
        ? [audio, audio]
        : mode === "resource"
          ? [
              {
                type: "resource_link",
                name: "report",
                uri: "file:///private/report",
                description: "Complete resource metadata",
                mimeType: "text/plain",
                size: 42,
              },
            ]
          : mode === "image"
            ? [image]
            : mode === "text"
              ? [{ type: "text", text: "Text control" }]
              : [{ type: "text", text: "Captured tone" }, audio, image, audio],
  ...(mode === "error" ? { isError: true } : {}),
}));
await server.connect(new StdioServerTransport());
