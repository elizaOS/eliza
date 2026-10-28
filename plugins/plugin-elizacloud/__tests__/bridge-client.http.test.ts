import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CloudBridgeError, ElizaCloudClient } from "../src/cloud/bridge-client.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("ElizaCloudClient bridge HTTP boundary", () => {
  it("reports a successful HTTP response without reply text as a failure", async () => {
    const responses: unknown[] = [
      { jsonrpc: "2.0", id: "empty", result: {} },
      { jsonrpc: "2.0", id: "valid", result: { text: "working reply" } },
    ];
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responses.shift()));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP proof server did not expose a TCP port");
    }

    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "eliza_test_key");

    await expect(client.sendMessage("agent-123", "hello")).rejects.toMatchObject({
      name: CloudBridgeError.name,
      message: "Bridge response did not include reply text",
    });
    await expect(client.sendMessage("agent-123", "hello again")).resolves.toBe("working reply");
    expect(paths).toEqual([
      "/api/v1/eliza/agents/agent-123/bridge",
      "/api/v1/eliza/agents/agent-123/bridge",
    ]);
  });
});
