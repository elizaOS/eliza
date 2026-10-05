import { randomUUID } from "node:crypto";
import { ChannelTopicsService, ChannelType, type UUID } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  disposeAssistantReasoning,
  installAssistantReasoning,
} from "../../runtime/assistant-reasoning.ts";
import { autonomyRoutes } from "../autonomy/routes.ts";
import { AutonomyService } from "../autonomy/service.ts";
import { basicCapabilityRoutes } from "./routes.ts";

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
const routes = [...basicCapabilityRoutes, ...autonomyRoutes];
async function call(path: string, values: Partial<RouteHandlerContext> = {}) {
  const route = routes.find(
    (candidate) =>
      candidate.path === path &&
      (!values.method || candidate.type === values.method),
  );
  if (!route?.routeHandler) throw new Error(`Missing route ${path}`);
  return route.routeHandler({
    signal: new AbortController().signal,
    runtime: fixture.runtime,
    method: route.type,
    path,
    params: {},
    query: {},
    headers: {},
    body: undefined,
    inProcess: true,
    ...values,
  });
}
beforeAll(async () => {
  fixture = await createTestRuntime({
    configureRuntime: (runtime) => {
      installAssistantReasoning(runtime);
    },
  });
}, 120_000);
afterAll(async () => {
  if (fixture) {
    disposeAssistantReasoning(fixture.runtime);
    await fixture.cleanup();
  }
}, 120_000);

it("reports unavailable services before registration, then changes the real autonomy state", async () => {
  expect((await call("/autonomy/status")).status).toBe(503);
  expect(
    (await call("/api/channel-topics/search", { query: { q: "billing" } }))
      .status,
  ).toBe(503);
  await fixture.runtime.registerService(AutonomyService);
  await fixture.runtime.getServiceLoadPromise(AutonomyService.serviceType);
  for (const body of [
    undefined,
    null,
    [],
    {},
    { interval: Number.NaN },
    { interval: Infinity },
    { interval: "5000" },
    { interval: 4999 },
    { interval: 600001 },
  ]) {
    expect((await call("/autonomy/interval", { body })).status).toBe(400);
  }
  expect(
    await call("/autonomy/interval", { body: { interval: 600000 } }),
  ).toMatchObject({
    status: 200,
    body: { data: { interval: 600000, intervalSeconds: 600 } },
  });
  for (const [operation, enabled] of [
    ["enable", true],
    ["toggle", false],
    ["toggle", true],
    ["disable", false],
  ] as const) {
    expect(await call(`/autonomy/${operation}`)).toMatchObject({
      status: 200,
      body: { data: { enabled, running: enabled } },
    });
    expect(fixture.runtime.enableAutonomy).toBe(enabled);
  }
  expect(await call("/autonomy/status")).toMatchObject({
    status: 200,
    body: {
      data: {
        enabled: false,
        running: false,
        interval: 600000,
        agentId: fixture.runtime.agentId,
      },
    },
  });
});

it("aborts actual active turns and retains idempotent status and default reasons", async () => {
  const roomId = randomUUID();
  const params = { roomId };
  expect((await call("/api/turns/:roomId")).status).toBe(400);
  expect((await call("/api/turns/:roomId/abort")).status).toBe(400);
  for (const reason of [undefined, "user_cancelled"]) {
    const active = fixture.runtime.turnControllers.runWith(
      roomId,
      (signal) =>
        new Promise<unknown>((resolve) => {
          signal.addEventListener("abort", () => resolve(signal.reason), {
            once: true,
          });
        }),
    );
    try {
      expect(await call("/api/turns/:roomId", { params })).toMatchObject({
        body: { active: true, hasSignal: true },
      });
      expect(
        await call("/api/turns/:roomId/abort", { params, body: { reason } }),
      ).toMatchObject({
        body: {
          aborted: true,
          roomId,
          reason: reason ?? "external_request",
        },
      });
      expect(await active).toMatchObject({
        reason: reason ?? "external_request",
      });
    } finally {
      fixture.runtime.turnControllers.abortTurn(roomId, "test-cleanup");
      await active;
    }
  }

  expect(await call("/api/turns/:roomId", { params })).toMatchObject({
    body: { active: false, hasSignal: false },
  });
  expect(await call("/api/turns/:roomId/abort", { params })).toMatchObject({
    body: { aborted: false },
  });
});

it("searches persisted room topics with strict query limits", async () => {
  await fixture.runtime.registerService(ChannelTopicsService);
  await fixture.runtime.getServiceLoadPromise(ChannelTopicsService.serviceType);
  const service =
    fixture.runtime.getService<ChannelTopicsService>("channel_topics");
  if (!service) throw new Error("Missing topic service");
  const ids = Array.from({ length: 105 }, () => randomUUID() as UUID);
  await fixture.runtime.createRooms(
    ids.map((id) => ({
      id,
      agentId: fixture.runtime.agentId,
      type: ChannelType.GROUP,
      source: "route-integration",
      name: id,
    })),
  );
  for (const id of ids) await service.recordTopics(id, ["billing"]);
  expect(
    (await fixture.runtime.getRoom(ids[0]))?.metadata?.currentTopics,
  ).toEqual(["billing"]);
  for (const query of [{}, { q: " " }, { q: [] }])
    expect((await call("/api/channel-topics/search", { query })).status).toBe(
      400,
    );
  for (const limit of [
    undefined,
    "5junk",
    "1e4",
    "5.5",
    "-5",
    "0",
    "9007199254740992",
  ]) {
    expect(
      await call("/api/channel-topics/search", {
        query: { q: "billing", ...(limit ? { limit } : {}) },
      }),
    ).toMatchObject({ status: 200, body: { count: 20 } });
  }
  expect(
    await call("/api/channel-topics/search", {
      query: { q: [" billing ", "ignored"], limit: [" 7 ", "99"] },
    }),
  ).toMatchObject({ body: { query: "billing", count: 7 } });
  expect(
    await call("/api/channel-topics/search", {
      query: { q: "billing", limit: "999999" },
    }),
  ).toMatchObject({ body: { count: 100 } });
});
