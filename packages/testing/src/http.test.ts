import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { req } from "./http.ts";

it("settles interrupted, timed out and canceled responses while preserving raw bodies", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/hang") return;
    if (request.url === "/truncate") {
      response.writeHead(200, { "content-length": "100" });
      response.write("partial");
      setTimeout(() => response.destroy(), 10);
      return;
    }
    response.end("raw fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    expect((await req(port, "GET", "/raw")).data).toEqual({
      _raw: "raw fixture",
    });
    await expect(req(port, "GET", "/truncate")).rejects.toThrow();
    await expect(
      req(port, "GET", "/hang", undefined, undefined, { timeoutMs: 20 }),
    ).rejects.toThrow();
    await expect(
      req(port, "GET", "/hang", undefined, undefined, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
