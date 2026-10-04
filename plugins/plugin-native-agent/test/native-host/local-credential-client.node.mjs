import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  createLocalCredentialStore,
  LocalCredentialBrokerError,
} from "../../native-host/local-credential-client.mjs";

const token = "synthetic-broker-token-only";
async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return instance.address().port;
}
const client = (port, options = {}) =>
  createLocalCredentialStore({ port, token, timeoutMs: 2000, ...options });
const unavailable = (error) =>
  error instanceof LocalCredentialBrokerError &&
  error.code === "CREDENTIAL_BROKER_UNAVAILABLE" &&
  error.message === "Local credential storage unavailable";

test("real loopback read/write/clear framing and explicit absence", async (t) => {
  let saved = null;
  const requests = [];
  const port = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      origin: req.headers.origin,
      body,
    });
    if (body.operation === "write") saved = body.value;
    if (body.operation === "clear") saved = null;
    res.end(JSON.stringify(body.operation === "read" ? { value: saved } : {}));
  });
  const store = client(port);
  assert.equal(await store.read(), null);
  assert.equal(await store.write("synthetic-value-雪"), null);
  assert.equal(await store.read(), "synthetic-value-雪");
  assert.equal(await store.clear(), null);
  assert.equal(await store.read(), null);
  assert.deepEqual(
    requests.map((r) => r.body.operation),
    ["read", "write", "read", "clear", "read"],
  );
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/credential");
    assert.equal(request.auth, `Bearer ${token}`);
    assert.equal(request.origin, undefined);
  }
});

test("bad credentials are rejected without exposing server diagnostics", async (t) => {
  let calls = 0;
  const port = await server(t, (req, res) => {
    calls++;
    req.resume();
    res.writeHead(req.headers.authorization === `Bearer ${token}` ? 200 : 403);
    res.end(JSON.stringify({ error: "synthetic-private-server-detail" }));
  });
  await assert.rejects(
    client(port, { token: "wrong-synthetic-token" }).read(),
    unavailable,
  );
  assert.equal(calls, 1);
});

test("redirect cannot forward credentials to another endpoint", async (t) => {
  let redirected = 0;
  const target = await server(t, (_req, res) => {
    redirected++;
    res.end("{}");
  });
  const port = await server(t, (req, res) => {
    req.resume();
    res.writeHead(307, { Location: `http://127.0.0.1:${target}/credential` });
    res.end();
  });
  await assert.rejects(client(port).write("synthetic"), unavailable);
  assert.equal(redirected, 0);
});

for (const [name, response] of [
  ["malformed JSON", "not json"],
  ["missing value", "{}"],
  ["nonstring value", '{"value":7}'],
  ["null body", "null"],
  ["array body", "[]"],
  ["error envelope", '{"value":null,"error":"synthetic"}'],
]) {
  test(`read rejects ${name} instead of reporting absent credentials`, async (t) => {
    const port = await server(t, (req, res) => {
      req.resume();
      res.end(response);
    });
    await assert.rejects(client(port).read(), unavailable);
  });
}

test("write errors and lost acknowledgements are never retried", async (t) => {
  let calls = 0;
  const port = await server(t, (req, res) => {
    calls++;
    req.resume();
    if (calls === 1) res.end('{"error":"synthetic"}');
    else req.socket.destroy();
  });
  const store = client(port);
  await assert.rejects(store.write("synthetic"), unavailable);
  await assert.rejects(store.clear(), unavailable);
  assert.equal(calls, 2);
});

test("host deadline covers a stalled response body without replay", async (t) => {
  let calls = 0;
  const port = await server(t, (req, res) => {
    calls++;
    req.resume();
    res.writeHead(200);
    res.write('{"value":');
  });
  await assert.rejects(
    client(port, {
      timeoutMs: 100,
      unavailableMessage: "Host storage unavailable",
    }).read(),
    (error) =>
      error instanceof LocalCredentialBrokerError &&
      error.message === "Host storage unavailable",
  );
  assert.equal(calls, 1);
});

test("invalid configuration and nonstring writes fail before transport", async () => {
  for (const options of [
    { port: 0 },
    { port: 65536 },
    { port: 1.5 },
    { token: "" },
    { token: "a\nb" },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
  ])
    assert.throws(() => client(12345, options), TypeError);
  await assert.rejects(client(12345).write(null), TypeError);
});
