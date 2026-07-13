/**
 * Regression: the cloud→sandbox SSE proxy must ACCUMULATE token deltas.
 *
 * A negotiated client's `streamProtocol:"delta-v2"` body can ride through the
 * bridge to the sandboxed agent, which then ships bare `{type:"token",text}`
 * deltas and re-sends `fullText` only on a periodic snapshot. If the proxy read
 * `fullText` off each frame (its old `data.fullText ?? data.text`), the
 * downstream `chunk` events would degrade to a single delta and `done` would
 * carry an empty/partial reply. Both `normalizeBridgeSseResponse`
 * implementations (the standalone bridge service and the duplicate on the host
 * service) must rebuild the full text. Real methods, no network.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { ElizaSandboxBridgeService } from "./eliza-sandbox-bridge";

// Match the main sandbox suite's module identity; Bun treats query aliases as separate modules.
const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");

type Normalizer = { normalizeBridgeSseResponse(response: Response): Response };

type AgentApiFetcher = {
  fetchAgentApi(
    rec: {
      id: string;
      environment_vars: Record<string, string>;
      bridge_url: string;
      health_url: string;
      node_id: string;
      bridge_port: number;
      web_ui_port: number;
      headscale_ip: string;
      sandbox_id: string;
    },
    path: string,
    init?: RequestInit,
  ): Promise<Response>;
};

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
});

function sseResponse(body: string): Response {
  return sseResponseChunks([body]);
}

function sseResponseChunks(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function readEvents(
  response: Response,
): Promise<Array<{ event: string | null; data: Record<string, unknown> }>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("normalized response has no body");
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  const events: Array<{ event: string | null; data: Record<string, unknown> }> = [];
  for (const frame of out.split("\n\n")) {
    if (!frame.trim()) continue;
    const lines = frame.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    events.push({
      event: eventLine ? eventLine.slice("event: ".length) : null,
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }
  return events;
}

const normalizers: Array<[string, () => Normalizer]> = [
  [
    "ElizaSandboxBridgeService",
    () => new ElizaSandboxBridgeService({} as never) as unknown as Normalizer,
  ],
  ["ElizaSandboxService", () => new ElizaSandboxService() as unknown as Normalizer],
];

for (const [label, make] of normalizers) {
  describe(`${label}.normalizeBridgeSseResponse accumulates delta-v2 frames`, () => {
    test("rebuilds fullText from bare deltas and carries it on done", async () => {
      const body =
        'data: {"type":"token","text":"Hello "}\n\n' +
        'data: {"type":"token","text":"world"}\n\n' +
        'data: {"type":"token","text":"!"}\n\n' +
        // done WITHOUT fullText — text must be the accumulated reply.
        'data: {"type":"done"}\n\n';
      const events = await readEvents(make().normalizeBridgeSseResponse(sseResponse(body)));

      const chunks = events.filter((event) => event.event === "chunk");
      expect(chunks.map((event) => event.data.chunk)).toEqual(["Hello ", "world", "!"]);
      // Each downstream chunk carries the ACCUMULATED text, not just its delta.
      expect(chunks.map((event) => event.data.fullText)).toEqual([
        "Hello ",
        "Hello world",
        "Hello world!",
      ]);
      const done = events.find((event) => event.event === "done");
      expect(done?.data.text).toBe("Hello world!");
    });

    test("a periodic fullText snapshot resets the accumulator authoritatively", async () => {
      const body =
        'data: {"type":"token","text":"Hello wrld"}\n\n' +
        // structured rewrite: authoritative full-text replace, no text field.
        'data: {"type":"token","fullText":"Hello world"}\n\n' +
        'data: {"type":"token","text":"!"}\n\n' +
        'data: {"type":"done","fullText":"Hello world!"}\n\n';
      const events = await readEvents(make().normalizeBridgeSseResponse(sseResponse(body)));

      const chunks = events.filter((event) => event.event === "chunk");
      expect(chunks.map((event) => event.data.fullText)).toEqual([
        "Hello wrld",
        "Hello world",
        "Hello world!",
      ]);
      // The snapshot frame has no delta, so its downstream chunk is empty.
      expect(chunks[1].data.chunk).toBe("");
      const done = events.find((event) => event.event === "done");
      expect(done?.data.text).toBe("Hello world!");
    });

    test("legacy per-token fullText still passes through unchanged", async () => {
      const body =
        'data: {"type":"token","text":"Hel","fullText":"Hel"}\n\n' +
        'data: {"type":"token","text":"lo","fullText":"Hello"}\n\n' +
        'data: {"type":"done","fullText":"Hello"}\n\n';
      const events = await readEvents(make().normalizeBridgeSseResponse(sseResponse(body)));

      const chunks = events.filter((event) => event.event === "chunk");
      expect(chunks.map((event) => event.data.fullText)).toEqual(["Hel", "Hello"]);
      const done = events.find((event) => event.event === "done");
      expect(done?.data.text).toBe("Hello");
    });

    test("buffers split SSE frames before parsing and accumulating", async () => {
      const events = await readEvents(
        make().normalizeBridgeSseResponse(
          sseResponseChunks([
            'data: {"type":"token","text":"Hel',
            'lo "}\n',
            "\n",
            'data: {"type":"token","text":"world"}\r\n',
            "\r\n",
            'data: {"type":"done"}\n\n',
          ]),
        ),
      );

      const chunks = events.filter((event) => event.event === "chunk");
      expect(chunks.map((event) => event.data.chunk)).toEqual(["Hello ", "world"]);
      expect(chunks.map((event) => event.data.fullText)).toEqual(["Hello ", "Hello world"]);
      const done = events.find((event) => event.event === "done");
      expect(done?.data.text).toBe("Hello world");
    });
  });
}

test("Worker routing returns an upstream SSE response without cloning or buffering", async () => {
  Object.defineProperty(globalThis, "WebSocketPair", {
    value: class WebSocketPair {},
    configurable: true,
  });
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        controller.enqueue(encoder.encode("data: second\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  let requestBody: BodyInit | null | undefined;
  globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = init?.body;
    return upstream;
  });

  const service = new ElizaSandboxService() as unknown as AgentApiFetcher;
  const response = await runWithCloudBindings(
    {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
    },
    () =>
      service.fetchAgentApi(
        {
          id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
          environment_vars: { ELIZA_API_TOKEN: "agent-token" },
          bridge_url: "https://legacy-bridge.example",
          health_url: "http://100.64.0.10:23816/api/health",
          node_id: "node-1",
          bridge_port: 18923,
          web_ui_port: 23816,
          headscale_ip: "100.64.0.10",
          sandbox_id: "sandbox-e06bb509",
        },
        "/api/conversations/conversation-1/messages/stream",
        {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        },
      ),
  );

  expect(response).toBe(upstream);
  expect(requestBody).toBe('{"text":"hello"}');
  expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
});
