import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithTimeoutGuard } from "./server-helpers-fetch.ts";

const TIMEOUT_MS = 300;
const BODY_DELAY_MS = 1_500;

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function startServer(
  mode: "stall-body" | "stall-headers" | "fast",
): Promise<string> {
  server = http.createServer((_req, res) => {
    if (mode === "fast") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (mode === "stall-headers") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, BODY_DELAY_MS);
      return;
    }
    // stall-body: headers and a partial body arrive at once; the rest of the
    // body is held back well past the guard deadline.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"ok":');
    setTimeout(() => {
      res.end("true}");
    }, BODY_DELAY_MS);
  });
  await new Promise<void>((resolve) =>
    server?.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/x`;
}

describe("fetchWithTimeoutGuard", () => {
  it("returns a fast response body in full", async () => {
    const url = await startServer("fast");
    const response = await fetchWithTimeoutGuard(url, {}, TIMEOUT_MS);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects when the response headers stall past the deadline", async () => {
    const url = await startServer("stall-headers");
    await expect(
      fetchWithTimeoutGuard(url, {}, TIMEOUT_MS),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the deadline active while the caller reads the body", async () => {
    const url = await startServer("stall-body");
    const response = await fetchWithTimeoutGuard(url, {}, TIMEOUT_MS);
    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
