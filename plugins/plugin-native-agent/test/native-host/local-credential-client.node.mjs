import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  createLocalCredentialStore,
  createLocalPendingCredentialStore,
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
for (const [label, createStore, wirePrefix] of [
  ["primary", createLocalCredentialStore, ""],
  ["pending enrollment", createLocalPendingCredentialStore, "pending-"],
]) {
  const testStore = (name, fn) => test(`${label}: ${name}`, fn);
  const client = (port, options = {}) =>
    createStore({ port, token, timeoutMs: 2000, ...options });
  const unavailable = (error) =>
    error instanceof LocalCredentialBrokerError &&
    error.code === "CREDENTIAL_BROKER_UNAVAILABLE" &&
    error.message === "Local credential storage unavailable";

  testStore(
    "real loopback read/write/clear framing and explicit absence",
    async (t) => {
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
        if (body.operation === `${wirePrefix}write`) saved = body.value;
        if (body.operation === `${wirePrefix}clear`) saved = null;
        res.end(
          JSON.stringify(
            body.operation === `${wirePrefix}read` ? { value: saved } : {},
          ),
        );
      });
      const store = client(port);
      assert.equal(await store.read(), null);
      assert.equal(await store.write("synthetic-value-雪"), null);
      assert.equal(await store.read(), "synthetic-value-雪");
      assert.equal(await store.clear(), null);
      assert.equal(await store.read(), null);
      assert.deepEqual(
        requests.map((r) => r.body.operation),
        ["read", "write", "read", "clear", "read"].map(
          (operation) => `${wirePrefix}${operation}`,
        ),
      );
      for (const request of requests) {
        assert.equal(request.method, "POST");
        assert.equal(request.path, "/credential");
        assert.equal(request.auth, `Bearer ${token}`);
        assert.equal(request.origin, undefined);
      }
    },
  );

  testStore(
    "bad credentials are rejected without exposing server diagnostics",
    async (t) => {
      let calls = 0;
      const port = await server(t, (req, res) => {
        calls++;
        req.resume();
        res.writeHead(
          req.headers.authorization === `Bearer ${token}` ? 200 : 403,
        );
        res.end(JSON.stringify({ error: "synthetic-private-server-detail" }));
      });
      await assert.rejects(
        client(port, { token: "wrong-synthetic-token" }).read(),
        unavailable,
      );
      assert.equal(calls, 1);
    },
  );

  testStore(
    "redirect cannot forward credentials to another endpoint",
    async (t) => {
      let redirected = 0;
      const target = await server(t, (_req, res) => {
        redirected++;
        res.end("{}");
      });
      const port = await server(t, (req, res) => {
        req.resume();
        res.writeHead(307, {
          Location: `http://127.0.0.1:${target}/credential`,
        });
        res.end();
      });
      await assert.rejects(client(port).write("synthetic"), unavailable);
      assert.equal(redirected, 0);
    },
  );

  for (const [name, response] of [
    ["malformed JSON", "not json"],
    ["missing value", "{}"],
    ["nonstring value", '{"value":7}'],
    ["null body", "null"],
    ["array body", "[]"],
    ["error envelope", '{"value":null,"error":"synthetic"}'],
  ]) {
    testStore(
      `read rejects ${name} instead of reporting absent credentials`,
      async (t) => {
        const port = await server(t, (req, res) => {
          req.resume();
          res.end(response);
        });
        await assert.rejects(client(port).read(), unavailable);
      },
    );
  }

  testStore(
    "write errors and lost acknowledgements are never retried",
    async (t) => {
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
    },
  );

  testStore(
    "host deadline covers a stalled response body without replay",
    async (t) => {
      let calls = 0;
      const port = await server(t, (req, res) => {
        calls++;
        req.resume();
        res.writeHead(200);
        res.write('{"value":');
      });
      await assert.rejects(
        client(port, {
          // Allow loopback setup under parallel JVM compilation so this exercises
          // an admitted, stalled response body rather than a pre-dispatch timeout.
          timeoutMs: 5000,
          unavailableMessage: "Host storage unavailable",
        }).read(),
        (error) =>
          error instanceof LocalCredentialBrokerError &&
          error.message === "Host storage unavailable",
      );
      assert.equal(calls, 1);
    },
  );

  testStore(
    "invalid configuration and nonstring writes fail before transport",
    async () => {
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
    },
  );
}

test("pending enrollment and primary credentials remain independent over real loopback", async (t) => {
  const saved = new Map([
    ["primary", null],
    ["pending", null],
  ]);
  const port = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const slots = {
      read: "primary",
      write: "primary",
      clear: "primary",
      "pending-read": "pending",
      "pending-write": "pending",
      "pending-clear": "pending",
    };
    assert.ok(Object.hasOwn(slots, body.operation));
    const slot = slots[body.operation];
    if (body.operation.endsWith("write")) saved.set(slot, body.value);
    if (body.operation.endsWith("clear")) saved.set(slot, null);
    res.end(
      JSON.stringify(
        body.operation.endsWith("read") ? { value: saved.get(slot) } : {},
      ),
    );
  });
  const options = { port, token, timeoutMs: 2000 };
  const primary = createLocalCredentialStore(options);
  const pending = createLocalPendingCredentialStore(options);
  await primary.write("synthetic-active-credential");
  await pending.write('{"kind":"revocation","synthetic":true}');
  assert.equal(await primary.read(), "synthetic-active-credential");
  assert.equal(await pending.read(), '{"kind":"revocation","synthetic":true}');
  await pending.clear();
  assert.equal(await primary.read(), "synthetic-active-credential");
  assert.equal(await pending.read(), null);
  await pending.write("synthetic-unacknowledged-enrollment");
  await primary.clear();
  assert.equal(await primary.read(), null);
  assert.equal(await pending.read(), "synthetic-unacknowledged-enrollment");
});

test("task key client preserves native-selected identity and rejects malformed material", async (t) => {
  const { createLocalTaskDataKeyStore } = await import(
    "../../native-host/local-credential-client.mjs"
  );
  const id = "12345678-1234-1234-1234-123456789abc";
  const value = JSON.stringify({
    version: 1,
    id,
    key: Buffer.alloc(32, 7).toString("base64"),
  });
  let response = { value: null };
  const requests = [];
  const port = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.end(JSON.stringify(response));
  });
  const client = createLocalTaskDataKeyStore({ port, token, timeoutMs: 2000 });
  assert.equal(await client.read(), null);
  response = { value };
  const created = await client.createForNewDatabase();
  assert.equal(created.id, id);
  assert.deepEqual(created.bytes, new Uint8Array(32).fill(7));
  created.bytes.fill(0);
  response = { removed: false };
  assert.equal(await client.remove(id), false);
  assert.deepEqual(requests, [
    { operation: "task-key-read" },
    { operation: "task-key-create" },
    { operation: "task-key-remove", value: id },
  ]);
  for (const invalid of [
    null,
    "{}",
    JSON.stringify({ version: 1, id, key: "AAAA" }),
    JSON.stringify({
      version: 2,
      id,
      key: Buffer.alloc(32).toString("base64"),
    }),
  ]) {
    response = { value: invalid };
    await assert.rejects(
      client.createForNewDatabase(),
      (error) =>
        error.code === "CREDENTIAL_BROKER_UNAVAILABLE" &&
        !error.message.includes("AAAA"),
    );
  }
  const before = requests.length;
  await assert.rejects(client.remove("invalid"), TypeError);
  await assert.rejects(client.remove({ toString: () => id }), TypeError);
  assert.equal(requests.length, before);
});

test("verified account client preserves opaque CAS snapshots over loopback without retries", async (t) => {
  const { createLocalVerifiedAccountStore } = await import(
    "../../native-host/local-credential-client.mjs"
  );
  let raw = null,
    calls = 0;
  const port = await server(t, async (req, res) => {
    calls++;
    let body = "";
    for await (const c of req) body += c;
    body = JSON.parse(body);
    if (body.operation === "verified-account-read")
      return res.end(JSON.stringify({ value: raw }));
    assert.deepEqual(Object.keys(body).sort(), [
      "expected",
      "operation",
      "value",
    ]);
    const exchanged = body.expected === raw;
    if (exchanged) raw = body.value;
    res.end(JSON.stringify({ exchanged }));
  });
  const client = createLocalVerifiedAccountStore({
    port,
    token,
    timeoutMs: 2000,
  });
  assert.equal(await client.read(), null);
  assert.equal(await client.compareExchange(null, "record-one"), true);
  assert.equal(await client.compareExchange(null, "stale"), false);
  assert.equal(await client.read(), "record-one");
  assert.equal(await client.compareExchange("record-one", null), true);
  const before = calls;
  await assert.rejects(client.compareExchange(undefined, "bad"), TypeError);
  assert.equal(calls, before);
});

for (const responseBody of [
  {},
  { exchanged: "true" },
  { exchanged: true, value: "private-canary" },
  { error: "private-canary" },
]) {
  test("verified exchange rejects malformed acknowledgement without leaking or retrying", async (t) => {
    const { createLocalVerifiedAccountStore } = await import(
      "../../native-host/local-credential-client.mjs"
    );
    let calls = 0;
    const port = await server(t, (req, res) => {
      calls++;
      req.resume();
      res.end(JSON.stringify(responseBody));
    });
    const client = createLocalVerifiedAccountStore({
      port,
      token,
      timeoutMs: 2000,
    });
    await assert.rejects(
      client.compareExchange(null, "synthetic"),
      (e) =>
        e.code === "CREDENTIAL_BROKER_UNAVAILABLE" &&
        !e.message.includes("canary"),
    );
    assert.equal(calls, 1);
  });
}
