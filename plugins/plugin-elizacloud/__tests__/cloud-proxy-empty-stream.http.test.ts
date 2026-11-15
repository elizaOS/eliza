import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudBridgeError, ElizaCloudClient } from "../src/cloud/bridge-client.js";
import { CloudRuntimeProxy } from "../src/cloud/cloud-proxy.js";

describe("CloudRuntimeProxy empty stream handling", () => {
  const servers = new Set<http.Server>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    servers.clear();
  });

  it("rejects an empty successful stream before a caller can resend the message", async () => {
    let streamRequests = 0;
    let bridgeRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith("/stream")) {
        streamRequests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('event: done\ndata: {"ok":true}\n\n');
        return;
      }
      if (request.url?.endsWith("/bridge")) {
        bridgeRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { text: "second response" } }));
        return;
      }
      response.writeHead(404).end();
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "test-key");
    const proxy = new CloudRuntimeProxy(client, "agent-123", "Agent");

    const runCloudCliTurn = async (): Promise<string> => {
      let responseText = "";
      for await (const chunk of proxy.handleChatMessageStream("run the task")) {
        responseText += chunk;
      }
      if (!responseText) {
        responseText = await proxy.handleChatMessage("run the task");
      }
      return responseText;
    };

    await expect(runCloudCliTurn()).rejects.toEqual(
      expect.objectContaining<Partial<CloudBridgeError>>({
        name: "CloudBridgeError",
        message: "Cloud stream ended without reply text",
      })
    );
    expect(streamRequests).toBe(1);
    expect(bridgeRequests).toBe(0);
  });

  it("returns a single-frame snapshot reply carried only in fullText", async () => {
    let bridgeRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith("/stream")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'event: chunk\ndata: {"text":"","fullText":"hi"}\n\n' +
            'event: done\ndata: {"fullText":"hi"}\n\n'
        );
        return;
      }
      if (request.url?.endsWith("/bridge")) {
        bridgeRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { text: "second response" } }));
        return;
      }
      response.writeHead(404).end();
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "test-key");
    const proxy = new CloudRuntimeProxy(client, "agent-123", "Agent");

    const chunks: string[] = [];
    for await (const chunk of proxy.handleChatMessageStream("run the task")) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("hi");
    expect(bridgeRequests).toBe(0);
  });
});

describe("CloudRuntimeProxy error frame handling", () => {
  const servers = new Set<http.Server>();

  afterEach(async () => {
    await Promise.all(
      [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    servers.clear();
  });

  // Frames written with the Cloud chatSseFrame format. The shared runtime and
  // the sandbox bridge end a turn they cannot finish with a terminal error
  // frame (bridge/active.ts, shared-runtime-chat.ts, stream/route.ts).
  async function startCloud(streamBody: string) {
    const requests = { stream: 0, bridge: 0 };
    const server = http.createServer((request, response) => {
      if (request.url?.endsWith("/stream")) {
        requests.stream += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(streamBody);
        return;
      }
      if (request.url?.endsWith("/bridge")) {
        requests.bridge += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { text: "second response" } }));
        return;
      }
      response.writeHead(404).end();
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }
    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "test-key");
    return { proxy: new CloudRuntimeProxy(client, "agent-123", "Agent"), requests };
  }

  // The cloud-mode CLI chat loop in packages/agent/src/runtime/eliza.ts.
  async function runCloudCliTurn(proxy: CloudRuntimeProxy, shown: string[]): Promise<string> {
    let responseText = "";
    for await (const chunk of proxy.handleChatMessageStream("what is the answer?")) {
      shown.push(chunk);
      responseText += chunk;
    }
    if (!responseText) {
      responseText = await proxy.handleChatMessage("what is the answer?");
    }
    return responseText;
  }

  it("rejects a turn whose stream ends in an error frame after partial text", async () => {
    const { proxy, requests } = await startCloud(
      'event: chunk\ndata: {"chunk":"The answer is","text":"The answer is","fullText":"The answer is","type":"token"}\n\n' +
        'event: error\ndata: {"message":"Shared runtime stream failed","type":"error"}\n\n'
    );
    const shown: string[] = [];

    await expect(runCloudCliTurn(proxy, shown)).rejects.toEqual(
      expect.objectContaining<Partial<CloudBridgeError>>({
        name: "CloudBridgeError",
        message: "Shared runtime stream failed",
      })
    );
    expect(shown).toEqual(["The answer is"]);
    expect(requests).toEqual({ stream: 1, bridge: 0 });
  });

  it("reports the error frame message when the stream carried no text", async () => {
    const { proxy, requests } = await startCloud(
      'event: error\ndata: {"message":"Sandbox is not running or unreachable","type":"error"}\n\n'
    );

    await expect(runCloudCliTurn(proxy, [])).rejects.toEqual(
      expect.objectContaining<Partial<CloudBridgeError>>({
        name: "CloudBridgeError",
        message: "Sandbox is not running or unreachable",
      })
    );
    expect(requests).toEqual({ stream: 1, bridge: 0 });
  });

  it("names a stream failure when the error frame has no message", async () => {
    const { proxy } = await startCloud('event: error\ndata: {"type":"error"}\n\n');

    await expect(runCloudCliTurn(proxy, [])).rejects.toEqual(
      expect.objectContaining<Partial<CloudBridgeError>>({
        name: "CloudBridgeError",
        message: "Cloud stream failed",
      })
    );
  });
});
