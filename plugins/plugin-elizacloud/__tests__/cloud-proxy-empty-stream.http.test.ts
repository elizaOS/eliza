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
