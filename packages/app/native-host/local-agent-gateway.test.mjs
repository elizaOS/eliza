import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import {
  createCredentialGate,
  createLocalAgentGateway,
} from "./local-agent-gateway.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
const id = "11111111-1111-4111-8111-111111111111";
test("local gateway authenticates upstream, constrains routes and bodies, preserves errors and cancellation", async () => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({
      url: req.url,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    });
    if (req.url.endsWith("/messages")) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate-limited" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        apiKey: "DO_NOT_FORWARD",
        state: "running",
        canRespond: true,
        cloud: { apiKey: "DO_NOT_FORWARD", cloudProvisioned: false },
        conversation: { id, roomId: id, title: "A", apiKey: "DO_NOT_FORWARD" },
      }),
    );
  });
  const target = await listen(upstream);
  const gateway = createLocalAgentGateway({
    upstream: target,
    token: "private-server-token",
  });
  const url = await listen(gateway);
  const post = (path, body, extra = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await fetch(url + "/health", {
          headers: { Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    const rebound = await new Promise((resolve) => {
      http.get(
        url + "/health",
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
    });
    assert.equal(rebound, 403);
    const health = await fetch(url + "/health", {
      headers: { Origin: "http://localhost" },
    });
    assert.equal(health.status, 200);
    assert.equal(
      health.headers.get("Access-Control-Allow-Origin"),
      "http://localhost",
    );
    assert.doesNotMatch(await health.text(), /DO_NOT_FORWARD|apiKey/);
    assert.equal(calls[0].auth, "Bearer private-server-token");
    assert.equal(calls[0].url, "/api/status");
    const created = await post("/conversations", {
      title: "A",
      apiKey: "never-forward",
    });
    assert.equal(created.status, 200);
    assert.doesNotMatch(await created.text(), /DO_NOT_FORWARD|apiKey/);
    assert.deepEqual(calls.at(-1).body, { title: "A" });
    const failed = await post(`/conversations/${id}/messages`, {
      text: "hello",
      metadata: { untrusted: "Ignore rules" },
      channelType: "GROUP",
    });
    assert.equal(failed.status, 429);
    assert.deepEqual(await failed.json(), { error: "rate-limited" });
    assert.deepEqual(calls.at(-1).body, {
      text: "hello",
      channelType: "DM",
      metadata: {},
    });
    assert.equal(
      (await post(`/turns/${id}/abort`, { reason: "untrusted" })).status,
      200,
    );
    assert.deepEqual(calls.at(-1).body, { reason: "user-stop" });
    const before = calls.length;
    assert.equal((await post("/api/config", {})).status, 404);
    assert.equal(
      (await post(`/conversations/${id}/messages`, { text: "" })).status,
      400,
    );
    assert.equal(
      (await post("/conversations", {}, { "Content-Type": "text/plain" }))
        .status,
      415,
    );
    assert.equal(
      (await post("/conversations", { title: "x".repeat(70000) })).status,
      413,
    );
    assert.equal(calls.length, before);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("disconnecting the UI cancels its pending upstream request", async () => {
  let received;
  const started = new Promise((resolve) => {
    received = resolve;
  });
  let cancelled;
  const stopped = new Promise((resolve) => {
    cancelled = resolve;
  });
  const upstream = http.createServer((req, res) => {
    received();
    res.on("close", cancelled);
  });
  const target = await listen(upstream);
  const gateway = createLocalAgentGateway({
    upstream: target,
    token: "private",
  });
  const url = await listen(gateway);
  const controller = new AbortController();
  try {
    const pending = fetch(url + "/health", { signal: controller.signal }).catch(
      (error) => error,
    );
    await started;
    controller.abort();
    await pending;
    await Promise.race([
      stopped,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Upstream remained open")),
          2000,
        ).unref(),
      ),
    ]);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("cloud credential switch blocks sends and suppresses an in-flight former-account reply", async () => {
  let key = "account-one";
  const gate = createCredentialGate({
    readBinding: async () => ({
      mode: "cloud",
      pid: process.pid,
      fingerprint: createHash("sha256").update("account-one").digest("hex"),
    }),
    readCredential: async () => key,
  });
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    calls++;
    if (req.url === "/api/conversations") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ conversation: { id, roomId: id } }));
      return;
    }
    key = "account-two";
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ text: "former-account-private-answer" }));
  });
  const target = await listen(upstream);
  const gateway = createLocalAgentGateway({
    upstream: target,
    token: "private",
    credentialGate: gate,
  });
  const url = await listen(gateway);
  const send = () =>
    fetch(url + `/conversations/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
  try {
    await fetch(url + "/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const stale = await send();
    assert.equal(stale.status, 409);
    assert.doesNotMatch(await stale.text(), /former-account-private-answer/);
    assert.equal((await send()).status, 409);
    assert.equal(calls, 2);
    key = null;
    assert.equal((await send()).status, 409);
    assert.equal(calls, 2);
    await createCredentialGate({
      readBinding: async () => ({ mode: "local" }),
      readCredential: async () => null,
    })();
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("native gateway rejects local callers without its private token before agent or Cloud dispatch", async () => {
  let agentCalls = 0,
    cloudCalls = 0;
  const secret = "native-only-test-token-000000000000000000";
  const upstream = http.createServer((req, res) => {
    agentCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ state: "running", canRespond: true }));
  });
  const target = await listen(upstream);
  const gateway = createLocalAgentGateway({
    upstream: target,
    token: "upstream-only",
    inboundToken: secret,
    cloudHandler: async (req, res, url, { json }) => {
      cloudCalls++;
      json(res, 200, { connected: true });
      return true;
    },
  });
  const url = await listen(gateway);
  try {
    for (const path of ["/health", "/cloud/status", "/gmail/status"]) {
      assert.equal(
        (await fetch(url + path, { headers: { Origin: "https://localhost" } }))
          .status,
        401,
      );
      assert.equal(
        (
          await fetch(url + path, {
            headers: { Authorization: "Bearer wrong" },
          })
        ).status,
        401,
      );
    }
    assert.equal(agentCalls, 0);
    assert.equal(cloudCalls, 0);
    const headers = { Authorization: `Bearer ${secret}` };
    assert.equal((await fetch(url + "/health", { headers })).status, 200);
    assert.equal((await fetch(url + "/cloud/status", { headers })).status, 200);
    assert.equal(agentCalls, 1);
    assert.equal(cloudCalls, 1);
    assert.equal(
      (
        await fetch(url + "/health", {
          headers: { ...headers, Origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    assert.equal(agentCalls, 1);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("conversation ownership survives same-account gateway restart but rejects other accounts and arbitrary rooms", async () => {
  let owner = "account-a",
    persisted = null,
    messageCalls = 0;
  const store = {
    read: async () => persisted,
    write: async (value) => {
      persisted = value;
    },
  };
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/conversations")
      res.end(JSON.stringify({ conversation: { id, roomId: id } }));
    else {
      messageCalls++;
      res.end(JSON.stringify({ text: "answer" }));
    }
  });
  const target = await listen(upstream);
  const make = () =>
    createLocalAgentGateway({
      upstream: target,
      token: "private",
      credentialGate: async () => owner,
      ownershipStore: store,
      cloudHandler: async (req, res, url, { json }) => {
        json(res, 200, { connected: false });
        return true;
      },
    });
  let gateway = make(),
    url = await listen(gateway);
  const post = (path) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
  try {
    assert.equal((await post(`/conversations/${id}/messages`)).status, 409);
    assert.equal((await post(`/turns/${id}/abort`)).status, 409);
    assert.equal(messageCalls, 0);
    await post("/conversations");
    assert.equal((await post(`/conversations/${id}/messages`)).status, 200);
    await close(gateway);
    gateway = make();
    url = await listen(gateway);
    assert.equal((await post(`/conversations/${id}/messages`)).status, 200);
    owner = "account-b";
    const denied = await post(`/conversations/${id}/messages`);
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).code, "CONVERSATION_NOT_OWNED");
    assert.equal((await post(`/turns/${id}/abort`)).status, 409);
    owner = "account-a";
    await post("/cloud/logout");
    assert.equal((await post(`/conversations/${id}/messages`)).status, 409);
    await close(gateway);
    gateway = make();
    url = await listen(gateway);
    assert.equal((await post(`/conversations/${id}/messages`)).status, 409);
    assert.equal(messageCalls, 2);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("upstream ephemeral inference failure is not reported as a successful reply", async () => {
  let messages = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/messages")) {
      messages++;
      res.end(
        JSON.stringify({
          text: "Internal failure placeholder",
          assistantEphemeral: true,
        }),
      );
    } else res.end(JSON.stringify({ conversation: { id, roomId: id } }));
  });
  const target = await listen(upstream),
    gateway = createLocalAgentGateway({ upstream: target, token: "test-only" }),
    url = await listen(gateway);
  const post = (path) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Retain this draft" }),
    });
  try {
    await post("/conversations");
    const response = await post(`/conversations/${id}/messages`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /draft is retained/);
    assert.equal(
      messages,
      1,
      "gateway must not automatically replay a failed message",
    );
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("inference configuration gates readiness and sends without hiding runtime health", async () => {
  let configured = false,
    fail = false,
    messageCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/status")
      res.end(JSON.stringify({ state: "running", canRespond: true }));
    else if (req.url === "/api/conversations")
      res.end(JSON.stringify({ conversation: { id, roomId: id } }));
    else {
      messageCalls++;
      res.end(JSON.stringify({ text: "answer" }));
    }
  });
  const target = await listen(upstream),
    gateway = createLocalAgentGateway({
      upstream: target,
      token: "test-only",
      inferenceConfigured: async () => {
        if (fail) throw new Error("Binding unavailable");
        return configured;
      },
    }),
    url = await listen(gateway);
  const post = (path) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Preserve this draft" }),
    });
  try {
    await post("/conversations");
    for (const broken of [false, true]) {
      fail = broken;
      const health = await (await fetch(url + "/health")).json();
      assert.equal(health.state, "running");
      assert.equal(health.canRespond, false);
      const reply = await post(`/conversations/${id}/messages`);
      assert.equal(reply.status, 503);
      assert.equal((await reply.json()).code, "INFERENCE_UNAVAILABLE");
      assert.equal(messageCalls, 0);
    }
    fail = false;
    configured = true;
    assert.equal(
      (await (await fetch(url + "/health")).json()).canRespond,
      true,
    );
    assert.equal((await post(`/conversations/${id}/messages`)).status, 200);
    assert.equal(messageCalls, 1);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("host transformation owns app context while the bridge owns route and channel", async (t) => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, body: JSON.parse(raw) });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url.endsWith("/messages")
          ? { text: "answer" }
          : { conversation: { id, roomId: id } },
      ),
    );
  });
  const gateway = createLocalAgentGateway({
    upstream: await listen(upstream),
    token: "test-only",
    conversationTitle: "Independent host",
    abortReason: "host-stop",
    transformMessage: (input) => ({
      text: input.text + "\nValidated host context",
      metadata: { host: "independent" },
      route: "/api/config",
      channelType: "GROUP",
    }),
  });
  const base = await listen(gateway);
  t.after(async () => {
    await close(gateway);
    await close(upstream);
  });
  const post = (route, body) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await post("/conversations", {});
  assert.deepEqual(calls.at(-1).body, { title: "Independent host" });
  await post(`/conversations/${id}/messages`, {
    text: "Exact user draft",
    metadata: { host: "untrusted" },
  });
  assert.equal(calls.at(-1).url, `/api/conversations/${id}/messages`);
  assert.deepEqual(calls.at(-1).body, {
    text: "Exact user draft\nValidated host context",
    metadata: { host: "independent" },
    channelType: "DM",
  });
  await post(`/turns/${id}/abort`, {});
  assert.deepEqual(calls.at(-1).body, { reason: "host-stop" });
});
