import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { type TestContext, test } from "node:test";
import { isPortOpen, readDevelopmentJson } from "./development-probes.ts";

async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("TCP transport observes listening and refused ports without retaining sockets", async (t) => {
  const { server, port } = await fixture(t, (_req, res) => res.end());
  assert.equal(await isPortOpen(port), true);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await isPortOpen(port), false);
  assert.throws(() => isPortOpen(port, "127.0.0.1", 0), RangeError);
});

test("JSON transport passes host headers without deciding readiness", async (t) => {
  const { url } = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.end(JSON.stringify({ state: "starting", canRespond: false }));
  });
  assert.deepEqual(
    await readDevelopmentJson(url, {
      headers: { Authorization: "Bearer fixture-token" },
    }),
    { state: "starting", canRespond: false },
  );
});

test("redirect is rejected without forwarding authorization", async (t) => {
  let hits = 0;
  const target = await fixture(t, (_req, res) => {
    hits++;
    res.end("{}");
  });
  const source = await fixture(t, (_req, res) => {
    res.writeHead(302, { Location: target.url });
    res.end();
  });
  assert.equal(
    await readDevelopmentJson(source.url, {
      headers: { Authorization: "Bearer fixture-token" },
    }),
    null,
  );
  assert.equal(hits, 0);
});

test("non-success and malformed JSON are unavailable", async (t) => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === "/error") res.statusCode = 503;
    res.end(req.url === "/error" ? "{}" : "invalid");
  });
  assert.equal(await readDevelopmentJson(`${url}/error`), null);
  assert.equal(await readDevelopmentJson(url), null);
});

test("deadline bounds a stalled response body and caller cancellation aborts headers", async (t) => {
  const { url } = await fixture(t, (req, res) => {
    if (req.url === "/body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    }
  });
  const began = Date.now();
  assert.equal(
    await readDevelopmentJson(`${url}/body`, { timeoutMs: 50 }),
    null,
  );
  assert.ok(Date.now() - began < 2000);
  const controller = new AbortController();
  const pending = readDevelopmentJson(url, {
    signal: controller.signal,
    timeoutMs: 5000,
  });
  controller.abort();
  assert.equal(await pending, null);
  await assert.rejects(readDevelopmentJson(url, { timeoutMs: 0 }), RangeError);
});
