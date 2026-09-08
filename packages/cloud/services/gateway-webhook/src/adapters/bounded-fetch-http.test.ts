/** Exercises all bounded cloud REST adapters against real local HTTP and compressed response bytes. */

import { createServer } from "node:http";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { boundedProviderFetch } from "@elizaos/cloud-shared/lib/utils/bounded-provider-fetch";
import { ownedBoundedFetch } from "@elizaos/cloud-shared/lib/utils/owned-bounded-fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundedGatewayFetch,
  GatewayProviderFetchError,
} from "./bounded-fetch";

let baseUrl: string;
const payload = JSON.stringify({ complete: "response ".repeat(100) });
const compressed = gzipSync(payload);
const connections = new Set<Socket>();
const server = createServer((req, res) => {
  if (req.url === "/headers") return;
  if (req.url === "/empty") {
    res.writeHead(204).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  if (req.url === "/body") {
    res.write('{"complete":');
    return;
  }
  if (req.url === "/gzip") {
    res.setHeader("content-encoding", "gzip");
    res.setHeader("content-length", compressed.length);
    res.end(compressed);
    return;
  }
  if (req.url === "/declared") {
    res.setHeader("content-length", "1000");
    res.flushHeaders();
    return;
  }
  res.write(payload);
  res.end();
});
server.on("connection", (socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local HTTP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    for (const socket of connections) socket.destroy();
    server.closeAllConnections();
  });
});

type Adapter = (
  path: string,
  timeoutMs?: number,
  maxResponseBytes?: number,
  signal?: AbortSignal,
) => Promise<Response>;
const adapters: { name: string; run: Adapter; sizeCode: string }[] = [
  {
    name: "owned",
    run: (path, timeoutMs = 2_000, maxResponseBytes = 4_096, signal) =>
      ownedBoundedFetch(
        `${baseUrl}${path}`,
        { signal },
        { timeoutMs, maxResponseBytes },
      ),
    sizeCode: "CLOUD_REST_RESPONSE_TOO_LARGE",
  },
  {
    name: "provider",
    run: (path, timeoutMs = 2_000, maxResponseBytes = 4_096, signal) =>
      boundedProviderFetch(
        `${baseUrl}${path}`,
        { signal },
        { timeoutMs, maxResponseBytes, provider: "twilio" },
      ),
    sizeCode: "PROVIDER_RESPONSE_TOO_LARGE",
  },
  {
    name: "gateway",
    run: (path, timeoutMs = 2_000, maxResponseBytes = 4_096, signal) =>
      boundedGatewayFetch(
        fetch,
        `${baseUrl}${path}`,
        { signal },
        timeoutMs,
        maxResponseBytes,
      ),
    sizeCode: "GATEWAY_RESPONSE_TOO_LARGE",
  },
];
for (const { name, run, sizeCode } of adapters) {
  describe(`${name} real HTTP transport`, () => {
    it.each(["/gzip", "/json"])(
      "returns complete decoded bytes and matching headers for %s",
      async (path) => {
        const response = await run(path);
        expect(await response.text()).toBe(payload);
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expect(response.headers.get("content-length")).toBe(
          String(Buffer.byteLength(payload)),
        );
      },
    );
    it("retains a bodyless protocol response", async () => {
      const response = await run("/empty");
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
    });
    it.each(["/declared", "/json", "/gzip"])(
      "rejects the complete response above its byte budget at %s",
      async (path) => {
        await expect(run(path, 2_000, 100)).rejects.toMatchObject({
          code: sizeCode,
        });
      },
    );
    it.each(["/headers", "/body"])(
      "retains the selected timeout through a %s stall",
      async (path) => {
        const started = performance.now();
        await expect(run(path, 60)).rejects.toMatchObject({
          name: "TimeoutError",
        });
        expect(performance.now() - started).toBeLessThan(800);
      },
    );
    it("retains caller cancellation through a response-body stall", async () => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const timer = setTimeout(() => controller.abort(reason), 60);
      try {
        await expect(
          run("/body", 2_000, 4_096, controller.signal),
        ).rejects.toBe(reason);
      } finally {
        clearTimeout(timer);
      }
    });
  });
}
it("keeps the gateway public error class and provider context", async () => {
  await expect(adapters[2].run("/json", 2_000, 1)).rejects.toBeInstanceOf(
    GatewayProviderFetchError,
  );
  await expect(adapters[1].run("/json", 2_000, 1)).rejects.toMatchObject({
    context: { provider: "twilio", maxResponseBytes: 1 },
  });
});
