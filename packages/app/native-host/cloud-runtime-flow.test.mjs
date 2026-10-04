import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCloudRoutes } from "./cloud-runtime-routes.mjs";

test("Cloud login, managed Gmail and voice use host credentials without creating a container", async (t) => {
  const calls = [];
  const secret = "host-only-test-key";
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (path === "/api/auth/cli-session")
      return Response.json({
        sessionId: "12345678-1234-1234-1234-123456789012",
      });
    if (path.startsWith("/api/auth/cli-session/"))
      return Response.json({
        status: "authenticated",
        apiKey: secret,
        userId: "private-user",
      });
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    if (path.endsWith("/connect/initiate")) {
      assert.deepEqual(JSON.parse(options.body), {
        side: "owner",
        capabilities: ["google.gmail.triage"],
      });
      return Response.json({
        authUrl: "https://accounts.google.com/authorize?state=fixture",
      });
    }
    if (path.endsWith("/google/status"))
      return Response.json({
        connected: true,
        configured: true,
        reason: "connected",
        grantedCapabilities: ["google.gmail.triage"],
        refreshToken: "never-forward",
      });
    const message = {
      externalId: "mail1",
      from: "test@example.test",
      subject: "Test mail",
      receivedAt: "2026-09-29",
      snippet: "Snippet",
      accessToken: "never-forward",
    };
    if (path.endsWith("/gmail/search"))
      return Response.json({ messages: [message], syncedAt: "now" });
    if (path.endsWith("/gmail/read"))
      return Response.json({ message, bodyText: "Full test message" });
    if (path.endsWith("/voice/tts"))
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    if (path.endsWith("/voice/stt")) {
      assert.ok(Buffer.isBuffer(options.body));
      assert.match(
        options.headers["Content-Type"],
        /^multipart\/form-data; boundary=eliza-/,
      );
      return Response.json({ text: "Hello" });
    }
    throw new Error("Unexpected Cloud path " + path);
  };
  const handler = createCloudRoutes({ fetchImpl });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url, "http://localhost")))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, payload) => {
    const response = await fetch(
      base + path,
      payload === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
    );
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await request("/gmail/status")).status, 401);
  const login = await request("/cloud/login", {});
  assert.equal(login.status, 200);
  assert.equal(
    (await request("/cloud/login/status?sessionId=unowned")).status,
    410,
  );
  const completed = await request(
    "/cloud/login/status?sessionId=" + login.value.sessionId,
  );
  assert.deepEqual(completed.value, {
    status: "authenticated",
    connected: true,
  });
  assert.equal((await request("/cloud/status")).value.connected, true);
  assert.equal(
    (await request("/gmail/connect", {})).value.browserUrl,
    "https://accounts.google.com/authorize?state=fixture",
  );
  assert.equal((await request("/gmail/status")).value.connected, true);
  const list = await request("/gmail/list", { query: "in:inbox" });
  assert.equal(list.value.messages[0].id, "mail1");
  assert.equal(
    (await request("/gmail/read", { messageId: "mail1" })).value.body,
    "Full test message",
  );
  assert.equal(
    (await request("/voice/tts", { text: "Hello" })).value.audioBase64,
    "AQID",
  );
  assert.equal(
    (
      await request("/voice/stt", {
        audioBase64: "AQID",
        mimeType: "audio/webm",
      })
    ).value.text,
    "Hello",
  );
  assert.equal(
    (
      await request("/voice/stt", {
        audioBase64: "bad!",
        mimeType: "text/plain",
      })
    ).status,
    400,
  );
  assert.equal(JSON.stringify(list).includes("never-forward"), false);
  assert.equal(JSON.stringify(completed).includes(secret), false);
  assert.equal(
    calls.some((c) => /agents|containers|provision/.test(c.path)),
    false,
  );
  await request("/cloud/logout", {});
  assert.equal((await request("/gmail/status")).status, 401);
});

test("Cloud errors retain status without reflecting credential-bearing upstream bodies", async (t) => {
  const handler = createCloudRoutes({
    initialApiKey: "secret",
    fetchImpl: async () =>
      new Response("secret private upstream detail", { status: 503 }),
  });
  const server = http.createServer((req, res) =>
    handler(req, res, new URL(req.url, "http://localhost")),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/gmail/status`,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Cloud request failed (HTTP 503)",
  });
});

test("Logout suppresses pending Gmail results from the former account", async (t) => {
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const handler = createCloudRoutes({
    initialApiKey: "former-account",
    fetchImpl: async () => {
      started();
      await paused;
      return Response.json({
        messages: [{ externalId: "private-old-message" }],
      });
    },
  });
  const server = http.createServer((req, res) =>
    handler(req, res, new URL(req.url, "http://localhost")),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = fetch(base + "/gmail/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  await began;
  await fetch(base + "/cloud/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  release();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes("private-old-message"), false);
});

test("Host credential store persists privately, rejects public permissions and deletes logout state", async (t) => {
  const { mkdtemp, stat, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createFileCredentialStore } = await import(
    "./cloud-runtime-routes.mjs"
  );
  const dir = await mkdtemp(join(tmpdir(), "eliza-cloud-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "cloud-credential");
  const store = createFileCredentialStore(path);
  assert.equal(await store.read(), null);
  await store.write("private-test-key");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    await createFileCredentialStore(path).read(),
    "private-test-key",
  );
  await chmod(path, 0o644);
  await assert.rejects(store.read(), /private/);
  await chmod(path, 0o600);
  await store.clear();
  assert.equal(await store.read(), null);
});

test("STT sends parseable multipart bytes and explicit boundary through an HTTP transport", async (t) => {
  const audio = Buffer.from([0, 255, 13, 10, 128, 42]);
  let received = 0;
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer wire-test-key");
    assert.match(
      req.headers["content-type"],
      /^multipart\/form-data; boundary=eliza-/,
    );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    assert.equal(Number(req.headers["content-length"]), raw.length);
    const multipart = await new Request("http://localhost/voice", {
      method: "POST",
      headers: req.headers,
      body: raw,
    }).formData();
    const file = multipart.get("audio");
    assert.equal(file.name, "recording");
    assert.equal(file.type, "audio/webm;codecs=opus");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
    received++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "Calendar" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const handler = createCloudRoutes({
    initialApiKey: "wire-test-key",
    fetchImpl: async (url, options) => {
      assert.ok(
        Buffer.isBuffer(options.body),
        "No FormData relies on transport header inference",
      );
      return fetch(
        `http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`,
        options,
      );
    },
  });
  const server = http.createServer((req, res) =>
    handler(req, res, new URL(req.url, "http://localhost")),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const send = async (mimeType) =>
    fetch(`http://127.0.0.1:${server.address().port}/voice/stt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: audio.toString("base64"), mimeType }),
    });
  const response = await send("audio/webm;codecs=opus");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Calendar" });
  assert.equal(received, 1);
  assert.equal((await send("audio/webm;\r\nX-Injected: yes")).status, 400);
  assert.equal(received, 1);
});
