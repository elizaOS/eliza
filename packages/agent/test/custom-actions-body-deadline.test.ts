/**
 * The guarded HTTP fetch keeps a deadline on the response body after headers:
 * a server that sends headers and then stalls fails at the idle timeout, a slow
 * body that keeps delivering bytes still completes, and the overall cap ends a
 * body that never finishes.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  __pinnedRequestForTests,
  __setBodyDeadlinesForTests,
  __setDnsLookupImplForTests,
  __setPinnedFetchImplForTests,
  performGuardedHttpGet,
} from "../src/runtime/custom-actions.ts";

let server: http.Server;
let port: number;
let stalledSocketClosed: Promise<void>;

beforeEach(async () => {
  __setBodyDeadlinesForTests({ idleMs: 300, totalMs: 3_000 });
  let markClosed: () => void = () => {};
  stalledSocketClosed = new Promise((resolve) => {
    markClosed = resolve;
  });
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    if (req.url === "/ok") {
      res.end("ok");
      return;
    }
    if (req.url === "/stall") {
      res.write("partial");
      req.socket.once("close", () => markClosed());
      return;
    }
    // /slow sends `count` chunks 100 ms apart; /drip never ends.
    const count = req.url === "/slow" ? 8 : Number.POSITIVE_INFINITY;
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (!res.writable) {
        clearInterval(timer);
        return;
      }
      res.write(`chunk${sent} `);
      if (sent >= count) {
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.once("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // Resolve the public test host to a public address, then send the real
  // pinned request to the local server instead.
  __setDnsLookupImplForTests(async () => [{ address: "93.184.216.34" }]);
  __setPinnedFetchImplForTests((input) =>
    __pinnedRequestForTests({
      ...input,
      url: new URL(`http://127.0.0.1:${port}${input.url.pathname}`),
      target: {
        ...input.target,
        hostname: "127.0.0.1",
        pinnedAddress: "127.0.0.1",
      },
    }),
  );
});

afterEach(async () => {
  __setBodyDeadlinesForTests(null);
  __setDnsLookupImplForTests(null);
  __setPinnedFetchImplForTests(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("fails a body that stalls after headers and closes the socket", async () => {
  const started = Date.now();
  await expect(
    performGuardedHttpGet("https://example.test/stall"),
  ).rejects.toThrow(/stalled/);
  expect(Date.now() - started).toBeLessThan(2_000);
  await stalledSocketClosed;
});

it("completes a slow body while bytes keep arriving", async () => {
  const result = await performGuardedHttpGet("https://example.test/slow");
  expect(result.ok).toBe(true);
  expect(result.text).toContain("chunk8");
});

it("ends a body that never finishes at the overall cap", async () => {
  const started = Date.now();
  await expect(
    performGuardedHttpGet("https://example.test/drip"),
  ).rejects.toThrow(/did not finish/);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
});

it("leaves a complete response unchanged", async () => {
  const result = await performGuardedHttpGet("https://example.test/ok");
  expect(result).toEqual({ ok: true, status: 200, text: "ok", blocked: false });
});
