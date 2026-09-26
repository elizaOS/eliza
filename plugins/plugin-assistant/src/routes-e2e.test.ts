/** Exercises the shipped assistant routes over the real host HTTP dispatcher. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/core/api/http-plugin-runtime";
import { afterEach, expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createAssistantPlugin } from "./index.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(authorized = true) {
  const runtime = new AgentRuntime({
    character: { name: "Assistant route fixture" },
    logLevel: "fatal",
  });
  registerHttpPluginRoutes(runtime, createAssistantPlugin());
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized: () => authorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    runtime,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

it("requires authorization for every shipped assistant route", async () => {
  const { base } = await startServer(false);
  for (const [method, path] of [
    ["GET", "/api/turns/room-1"],
    ["POST", "/api/turns/room-1/abort"],
    ["GET", "/assistant/api/channel-topics/search?q=release"],
  ]) {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(401);
  }
});

it("reports and aborts a real active turn without affecting another room", async () => {
  const { runtime, base } = await startServer();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let activeSignal!: AbortSignal;
  const active = runtime.turnControllers.runWith("room-1", async (signal) => {
    activeSignal = signal;
    await pending;
  });
  try {
    const status = await fetch(`${base}/api/turns/room-1`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      roomId: "room-1",
      active: true,
      hasSignal: true,
    });
    const other = await fetch(`${base}/api/turns/room-2/abort`, {
      method: "POST",
    });
    expect(await other.json()).toMatchObject({
      aborted: false,
      roomId: "room-2",
    });
    expect(activeSignal.aborted).toBe(false);
    const abort = await fetch(`${base}/api/turns/room-1/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "user_cancelled" }),
    });
    expect(abort.status).toBe(200);
    expect(await abort.json()).toEqual({
      aborted: true,
      roomId: "room-1",
      reason: "user_cancelled",
    });
    expect(activeSignal.aborted).toBe(true);
  } finally {
    release();
    await active;
  }
  const completed = await fetch(`${base}/api/turns/room-1`);
  expect(await completed.json()).toEqual({
    roomId: "room-1",
    active: false,
    hasSignal: false,
  });
});

it("validates channel topic queries and reports an unavailable service", async () => {
  const { base } = await startServer();
  const missing = await fetch(`${base}/assistant/api/channel-topics/search`);
  expect(missing.status).toBe(400);
  const unavailable = await fetch(
    `${base}/assistant/api/channel-topics/search?q=release`,
  );
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    error: "channel topics service unavailable",
    hits: [],
  });
});
