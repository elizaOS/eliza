import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AccessContext, UUID } from "@elizaos/core";
import {
  getHttpRuntime,
  type Route,
  registerHttpPluginRoutes,
} from "@elizaos/host/protocol";
import {
  autonomyCapabilities,
  createAssistantBehavior,
} from "@elizaos/plugin-assistant";
import { dispatchBufferedRequest } from "@elizaos/plugin-native-inference/android/dispatch";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tryHandleHonoRuntimeRoute } from "./hono-mount.ts";
import { dispatchApiRoute, registerInProcessApi } from "./in-process-api.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Server;
let base: string;
const failures: unknown[] = [];
const tokens = [randomUUID(), randomUUID()];
const contexts = tokens.map<AccessContext>(() => ({
  requesterEntityId: randomUUID() as UUID,
  worldId: randomUUID() as UUID,
  authorizedRoomIds: [randomUUID() as UUID],
  role: "USER",
  isOwner: false,
  source: "http-fixture",
}));
let arrivals = 0;
let release: () => void;
const overlap = new Promise<void>((resolve) => {
  release = resolve;
});

beforeAll(async () => {
  fixture = await createTestRuntime();
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/context-check/:mode",
    routeHandler: async (ctx) => {
      if (ctx.params.mode === "parallel") {
        if (++arrivals === 2) release();
        await overlap;
      }
      const body = {
        accessContext: structuredClone(ctx.accessContext),
        inProcess: ctx.inProcess,
        trustedLocal: ctx.isTrustedLocal,
      };
      if (ctx.accessContext) {
        ctx.accessContext.source = "handler-mutation";
        (ctx.accessContext.authorizedRoomIds as UUID[]).splice(0);
      }
      return { status: Number(ctx.params.mode) || 200, body };
    },
  });
  server = createServer((req, res) => {
    const index = tokens.findIndex(
      (token) => req.headers.authorization === `Bearer ${token}`,
    );
    void tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime: fixture.runtime,
      isAuthorized: () => index !== -1,
      isTrustedLocal: () => false,
      accessContext: () => contexts[index],
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      })
      .catch((error: unknown) => {
        failures.push(error);
        res.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP address");
  base = `http://127.0.0.1:${address.port}/api/context-check/`;
}, 120_000);

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  if (fixture) await fixture.cleanup();
  expect(failures).toEqual([]);
}, 120_000);

it.each([204, 205, 304])(
  "drops a handler body for HTTP status %i",
  async (status) => {
    const response = await fetch(`${base}${status}`, {
      headers: { Authorization: `Bearer ${tokens[0]}` },
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  },
);

it("keeps trusted contexts complete and isolated despite forged headers and overlapping requests", async () => {
  const original = structuredClone(contexts);
  const forged = {
    "x-eliza-internal-authorized": "1",
    "x-eliza-internal-in-process": "1",
    "x-eliza-internal-trusted-local": "1",
    "x-eliza-internal-access-context": JSON.stringify({
      requesterEntityId: randomUUID(),
      role: "OWNER",
      isOwner: true,
    }),
  };
  const denied = await fetch(`${base}parallel`, { headers: forged });
  expect(denied.status).toBe(401);
  expect(await denied.json()).toMatchObject({ error: "Unauthorized" });
  const responses = await Promise.all(
    tokens.map((token) =>
      fetch(`${base}parallel`, {
        headers: { ...forged, Authorization: `Bearer ${token}` },
      }),
    ),
  );
  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessContext: original[index],
      inProcess: false,
      trustedLocal: false,
    });
  }
  expect(arrivals).toBe(2);
  expect(contexts).toEqual(original);
});

it("cancels a streaming producer when its HTTP client disconnects", async () => {
  let finish!: () => void;
  const finalized = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let routeSignal: AbortSignal | undefined;
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/cancellation-http",
    routeHandler: async ({ signal }) => {
      routeSignal = signal;
      return {
        status: 200,
        stream: (async function* () {
          try {
            yield "first";
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
          } finally {
            finish();
          }
        })(),
      };
    },
  });
  const controller = new AbortController();
  try {
    const response = await fetch(new URL("/api/cancellation-http", base), {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${tokens[0]}` },
    });
    if (!response.body) throw new Error("Missing response stream");
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    controller.abort();
    await finalized;
    expect(routeSignal?.aborted).toBe(true);
  } finally {
    controller.abort();
  }
});

it("propagates native cancellation through the registered HTTP kernel", async () => {
  const controller = new AbortController();
  const reason = new Error("Native caller cancelled");
  let finalized = false;
  let routeSignal: AbortSignal | undefined;
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/cancellation-native",
    routeHandler: async ({ signal }) => {
      routeSignal = signal;
      return {
        status: 200,
        stream: (async function* () {
          try {
            yield "first";
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
          } finally {
            finalized = true;
          }
        })(),
      };
    },
  });
  const unregister = registerInProcessApi(fixture.runtime, {
    handle: async (req, res) => {
      await tryHandleHonoRuntimeRoute({
        req,
        res,
        runtime: fixture.runtime,
        isAuthorized: () => true,
      });
    },
  });
  try {
    await expect(
      dispatchApiRoute({
        runtime: fixture.runtime,
        method: "GET",
        path: "/api/cancellation-native",
        headers: {},
        inProcess: true,
        isAuthorized: () => true,
        signal: controller.signal,
        onChunk: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(routeSignal?.aborted).toBe(true);
    expect(finalized).toBe(true);
  } finally {
    unregister();
  }
});

it("rejects a partial producer failure over HTTP and native dispatch", async () => {
  let fail!: () => void;
  let finalized = 0;
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/failed-stream",
    routeHandler: async () => ({
      status: 200,
      stream: (async function* () {
        try {
          const proceed = new Promise<void>((resolve) => {
            fail = resolve;
          });
          yield "partial";
          await proceed;
          throw new Error("Producer failed");
        } finally {
          finalized++;
        }
      })(),
    }),
  });
  const response = await fetch(new URL("/api/failed-stream", base), {
    headers: { Authorization: `Bearer ${tokens[0]}` },
  });
  if (!response.body) throw new Error("Missing response stream");
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
  fail();
  await expect(reader.read()).rejects.toThrow();
  const unregister = registerInProcessApi(fixture.runtime, {
    handle: async (req, res) => {
      await tryHandleHonoRuntimeRoute({
        req,
        res,
        runtime: fixture.runtime,
        isAuthorized: () => true,
      });
    },
  });
  try {
    await expect(
      dispatchApiRoute({
        runtime: fixture.runtime,
        method: "GET",
        path: "/api/failed-stream",
        headers: {},
        inProcess: true,
        isAuthorized: () => true,
        onChunk: () => fail(),
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_ROUTE_STREAM_FAILED" });
    expect(finalized).toBe(2);
    expect(
      fixture.runtime
        .getRecentReportedErrors()
        .filter((error) => error.scope === "http.pluginStream"),
    ).toHaveLength(2);
  } finally {
    unregister();
  }
});

it("cancels Android buffered dispatch and refuses a pre-aborted request", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let invocations = 0;
  let finalized = false;
  getHttpRuntime(fixture.runtime).routes.push({
    type: "GET",
    path: "/api/android-cancellation",
    routeHandler: async ({ signal }) => {
      invocations++;
      started();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      finalized = true;
      return { status: 200, body: "must not be returned" };
    },
  });
  const unregister = registerInProcessApi(fixture.runtime, {
    handle: async (req, res) => {
      await tryHandleHonoRuntimeRoute({
        req,
        res,
        runtime: fixture.runtime,
        isAuthorized: () => true,
      });
    },
  });
  const controller = new AbortController();
  const reason = new Error("Android caller cancelled");
  const call = () =>
    dispatchBufferedRequest(
      fixture.runtime,
      dispatchApiRoute,
      { path: "/api/android-cancellation" },
      {
        fullApiKernel: true,
        configFileExists: () => false,
        loadElizaConfig: () => ({}),
        saveElizaConfig: () => {
          throw new Error("Unexpected config save");
        },
        hasPersistedFirstRunState: () => false,
      },
      controller.signal,
    );
  try {
    const pending = call();
    await entered;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(call()).rejects.toBe(reason);
    expect(invocations).toBe(1);
    expect(finalized).toBe(true);
  } finally {
    controller.abort(reason);
    unregister();
  }
});

it("serves the consolidated assistant routes through authenticated HTTP", async () => {
  getHttpRuntime(fixture.runtime).routes.push(
    ...(createAssistantBehavior().routes ?? []),
    ...autonomyCapabilities.routes,
  );
  const headers = {
    Authorization: `Bearer ${tokens[0]}`,
    "content-type": "application/json",
  };
  const roomId = randomUUID();
  const statusUrl = new URL(`/api/turns/${roomId}`, base);
  const denied = await fetch(statusUrl);
  expect(denied.status).toBe(401);
  const pending = fixture.runtime.turnControllers.runWith(
    roomId,
    (signal) =>
      new Promise<unknown>((resolve) => {
        signal.addEventListener("abort", () => resolve(signal.reason), {
          once: true,
        });
      }),
  );
  try {
    const active = await fetch(statusUrl, { headers });
    expect(await active.json()).toEqual({
      roomId,
      active: true,
      hasSignal: true,
    });
    const abort = await fetch(`${statusUrl}/abort`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "http-stop" }),
    });
    expect(await abort.json()).toEqual({
      roomId,
      aborted: true,
      reason: "http-stop",
    });
    expect(await pending).toMatchObject({ reason: "http-stop" });
    const idle = await fetch(statusUrl, { headers });
    expect(await idle.json()).toEqual({
      roomId,
      active: false,
      hasSignal: false,
    });
    for (const path of [
      "/api/channel-topics/search?q=billing",
      "/autonomy/status",
    ]) {
      const response = await fetch(new URL(path, base), { headers });
      expect(response.status).toBe(503);
      await response.arrayBuffer();
    }
  } finally {
    fixture.runtime.turnControllers.abortTurn(roomId, "test-cleanup");
    await pending;
  }
});

it("updates HTTP paths, methods and authorization when route contributions change", async () => {
  const path = "/api/reload-fixture";
  const headers = { Authorization: `Bearer ${tokens[0]}` };
  const install = (routes: Route[]) =>
    registerHttpPluginRoutes(fixture.runtime, {
      name: "reload-fixture",
      description: "HTTP route lifecycle",
      routes,
    });
  const route = (version: number): Route => ({
    type: "GET",
    path,
    rawPath: true,
    routeHandler: async () => ({ status: 200, body: { version } }),
  });
  const request = (target = path, method = "GET") =>
    fetch(new URL(target, base), { method, headers });
  try {
    install([route(1)]);
    expect(await (await request()).json()).toEqual({ version: 1 });
    install([route(2)]);
    expect(await (await request()).json()).toEqual({ version: 2 });
    const moved = `${path}/moved`;
    install([{ ...route(3), path: moved, type: "POST" }]);
    expect((await request()).status).toBe(404);
    expect((await request(moved)).status).toBe(404);
    expect((await fetch(new URL(moved, base), { method: "POST" })).status).toBe(
      401,
    );
    expect(await (await request(moved, "POST")).json()).toEqual({ version: 3 });
    install([]);
    expect((await request(moved, "POST")).status).toBe(404);
  } finally {
    install([]);
  }
});
