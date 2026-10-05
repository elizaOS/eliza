import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  createRuntimeJsonClient,
  type RuntimeJsonBridge,
  RuntimeRequestError,
} from "./runtime-json-client.ts";

const messages = {
  invalidPath: "path",
  startup: "startup",
  changed: "changed",
  request: "request",
  fallback: "fallback",
  invalidJson: "json",
};
const running = { available: true, state: "running" };
const bridge = (): RuntimeJsonBridge => ({
  status: async () => running,
  start: async () => running,
  restart: async () => running,
  request: async () => ({ status: 200, data: { ok: true } }),
});
const setup = (native: RuntimeJsonBridge | null, more = {}) =>
  createRuntimeJsonClient({
    nativePlatform: () => true,
    nativeBridge: () => native,
    nativeFallback: async () => ({ status: 200, data: "fallback" }),
    webUrl: (path) => path,
    startupTimeoutMs: 200,
    pollMs: 5,
    requestTimeoutMs: 1000,
    messages,
    ...more,
  });

test("concurrent native requests start once and do not replay requests", async () => {
  const native = bridge();
  let starts = 0,
    requests = 0;
  native.status = async () => ({ available: true, state: "stopped" });
  native.start = async () => {
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return running;
  };
  native.request = async () => ({ status: 200, data: ++requests });
  const client = setup(native);
  assert.deepEqual(
    await Promise.all([client.request("/a"), client.request("/b", {})]),
    [1, 2],
  );
  assert.equal(starts, 1);
  assert.equal(requests, 2);
});
test("available native failures never fall back; absent native may use host fallback", async () => {
  const native = bridge();
  let fallbacks = 0;
  native.request = async () => ({
    status: 409,
    data: { error: "conflict", code: "STALE" },
  });
  const fallback = async () => {
    fallbacks++;
    return { status: 200, data: "fallback" };
  };
  await assert.rejects(
    setup(native, { nativeFallback: fallback }).request("/a"),
    (error) =>
      error instanceof RuntimeRequestError &&
      error.status === 409 &&
      error.code === "STALE",
  );
  assert.equal(fallbacks, 0);
  assert.equal(
    await setup(null, { nativeFallback: fallback }).request("/a"),
    "fallback",
  );
  await assert.rejects(setup(null).request("//external"), /path/);
});
test("account refresh rejects a late old response without replay", async () => {
  const native = bridge();
  let release: (value: { status: number; data: string }) => void = () => {};
  let dispatched: () => void = () => {};
  const sent = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  let requests = 0;
  native.request = async () => {
    requests++;
    dispatched();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const client = setup(native);
  const old = client.request("/a", {});
  const rejected = assert.rejects(old, /changed/);
  await sent;
  await client.refreshNativeAccount();
  release({ status: 200, data: "old" });
  await rejected;
  assert.equal(requests, 1);
});
test("startup deadline rejects a stalled bridge start without dispatch or fallback", async () => {
  const native = bridge();
  let dispatches = 0;
  native.status = async () => ({ available: true, state: "stopped" });
  native.start = () => new Promise(() => {});
  native.request = async () => {
    dispatches++;
    return { status: 200, data: null };
  };
  await assert.rejects(
    setup(native, { startupTimeoutMs: 20 }).request("/a"),
    /startup/,
  );
  assert.equal(dispatches, 0);
});
test("web transport serializes JSON and preserves structured HTTP errors", async (t) => {
  const server = createServer(async (req, res) => {
    if (req.url === "/bad") {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "denied", code: "NO" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(
      JSON.stringify({
        method: req.method,
        body,
        contentType: req.headers["content-type"],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = setup(null, {
    nativePlatform: () => false,
    webUrl: (path: string) => `http://127.0.0.1:${address.port}${path}`,
  });
  assert.deepEqual(await client.request("/ok", { value: 1 }), {
    method: "POST",
    body: '{"value":1}',
    contentType: "application/json",
  });
  await assert.rejects(
    client.request("/bad"),
    (error) =>
      error instanceof RuntimeRequestError &&
      error.status === 403 &&
      error.code === "NO",
  );
});

test("late status after startup timeout cannot continue polling", async () => {
  const native = bridge();
  let statuses = 0;
  let release: (value: { available: boolean; state: string }) => void =
    () => {};
  native.start = async () => ({ available: true, state: "starting" });
  native.status = async () => {
    statuses++;
    if (statuses === 1) return { available: true, state: "stopped" };
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const client = setup(native, { startupTimeoutMs: 500, pollMs: 1 });
  await assert.rejects(client.request("/a"), /startup/);
  release({ available: true, state: "starting" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(statuses, 2);
});

test("removing a native bridge still fences an old account response", async () => {
  const native = bridge();
  let selected: RuntimeJsonBridge | null = native;
  let release!: (value: { status: number; data: string }) => void;
  let dispatched!: () => void;
  const sent = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  native.request = () => {
    dispatched();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const client = setup(native, { nativeBridge: () => selected });
  const response = client.request("/private");
  const checked = assert.rejects(response, /changed/);
  await sent;
  selected = null;
  await client.refreshNativeAccount();
  release({ status: 200, data: "old account" });
  await checked;
});

test("requests wait until the current account restart has completed", async () => {
  const native = bridge();
  let release!: (value: { available: boolean; state: string }) => void;
  let restarting!: () => void;
  const begun = new Promise<void>((resolve) => {
    restarting = resolve;
  });
  native.restart = () => {
    restarting();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  let requests = 0;
  native.request = async () => {
    requests++;
    return { status: 200, data: "current" };
  };
  const client = setup(native);
  const refresh = client.refreshNativeAccount();
  await begun;
  const response = client.request("/private");
  await new Promise((resolve) => setImmediate(resolve));
  const premature = requests;
  release(running);
  await refresh;
  assert.equal(await response, "current");
  assert.equal(premature, 0);
  assert.equal(requests, 1);
});

test("a stalled account restart releases waiting callers at the startup deadline", async () => {
  const native = bridge();
  native.restart = () => new Promise(() => {});
  let requests = 0;
  native.request = async () => {
    requests++;
    return { status: 200, data: null };
  };
  const client = setup(native, { startupTimeoutMs: 40 });
  const refresh = client.refreshNativeAccount().then(
    () => "resolved",
    (error) => error.message,
  );
  const request = client.request("/private").then(
    () => "resolved",
    (error) => error.message,
  );
  const outcomes = await Promise.race([
    Promise.all([refresh, request]),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
  ]);
  assert.deepEqual(outcomes, ["startup", "startup"]);
  await assert.rejects(client.request("/private"), /startup/);
  assert.equal(requests, 0);
  native.restart = async () => running;
  await client.refreshNativeAccount();
  await client.request("/private");
  assert.equal(requests, 1);
});
