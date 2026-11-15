import assert from "node:assert/strict";
import test from "node:test";
import { createSurfaceCommandChannel } from "./surface-channel.mjs";
import { connectSurfaceCommandClient } from "./surface-client.mjs";

test("close does not wait for a held pull the adapter cannot abort", async (t) => {
  const pullHoldMs = 5000;
  const channel = createSurfaceCommandChannel({
    credentialGate: async () => "owner",
    pullHoldMs,
  });
  t.after(() => channel.close());
  const paths = [];
  // Like an adapter that only checks its signal before and after the request.
  const request = async (path, body) => {
    paths.push(path);
    return channel.handle(path, body);
  };
  const client = await connectSurfaceCommandClient({
    request,
    clientId: "c",
    epoch: 1,
    handleCommand: async () => ({ ok: true }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(paths, [
    "/browser/surface/connect",
    "/browser/surface/pull",
  ]);
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 1000, "close settled before the hold ended");
  assert.equal(channel.connectionId(), null);
  assert.equal(
    paths.filter((path) => path === "/browser/surface/close").length,
    1,
  );
});

test("an aborted signal closes the host connection at once", async (t) => {
  const channel = createSurfaceCommandChannel({
    credentialGate: async () => "owner",
  });
  t.after(() => channel.close());
  const controller = new AbortController();
  const client = await connectSurfaceCommandClient({
    request: (path, body) => channel.handle(path, body),
    clientId: "c",
    epoch: 1,
    handleCommand: async () => ({ ok: true }),
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(channel.connectionId(), null);
  await client.completion;
});

test("a command still runs and replies through the client", async (t) => {
  const channel = createSurfaceCommandChannel({
    credentialGate: async () => "owner",
  });
  t.after(() => channel.close());
  const client = await connectSurfaceCommandClient({
    request: (path, body) => channel.handle(path, body),
    clientId: "c",
    epoch: 1,
    handleCommand: async (input) => ({ echo: input.value }),
  });
  assert.deepEqual(await channel.request({ value: 7 }, { effect: false }), {
    echo: 7,
  });
  await client.close();
  assert.equal(channel.connectionId(), null);
});
