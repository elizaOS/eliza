import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeJsonRpcUrl,
  probeJsonRpcEndpoint,
  TxService,
} from "./tx-service";

const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const servers: http.Server[] = [];

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test HTTP server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("tx-service JSON-RPC endpoint validation", () => {
  afterEach(async () => {
    await Promise.allSettled(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("rejects blank and non-http RPC URLs before constructing a provider", () => {
    expect(() => normalizeJsonRpcUrl("   ")).toThrow(
      "JSON-RPC URL is required",
    );
    expect(() => normalizeJsonRpcUrl("ws://127.0.0.1:8545")).toThrow(
      "expected http: or https:",
    );
    expect(() => new TxService("   ", TEST_PRIVATE_KEY)).toThrow(
      "JSON-RPC URL is required",
    );
  });

  it("accepts an endpoint that answers eth_chainId", async () => {
    const { url } = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    });

    await expect(probeJsonRpcEndpoint(url)).resolves.toEqual({ ok: true });
  });

  it("reports HTTP endpoints that are not JSON-RPC endpoints as unavailable", async () => {
    const { url } = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });

    await expect(probeJsonRpcEndpoint(url)).resolves.toMatchObject({
      ok: false,
      reason: "HTTP 404 Not Found",
    });
  });
});
