/**
 * Exercises handlePushTokenRoute (register/list/unregister device push tokens
 * under /api/notifications/push-tokens) against a real NotificationPushService
 * and PushTokenRegistry backed by an in-memory Map cache — covering 201
 * register, 400 validation, GET count with per-platform breakdown, DELETE
 * existence reporting, and the 503 returned when the push service is
 * unregistered.
 */
import type http from "node:http";
import { createMockRuntime } from "@elizaos/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationPushService } from "../services/push/notification-push-service.ts";
import type { PushTokenRegistry } from "../services/push/push-token-registry.ts";
import { handlePushTokenRoute } from "./push-token-routes.ts";

async function makeRuntimeWithService(): Promise<{
  runtime: { getService: (t: string) => unknown };
  registry: PushTokenRegistry;
}> {
  const cache = new Map<string, unknown>();
  const baseRuntime = createMockRuntime({
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
    // No AGENT_EVENT bus → the service starts dormant (fine for route tests).
    getService: () => null,
  });
  const service = (await NotificationPushService.start(
    baseRuntime,
  )) as NotificationPushService;
  const runtime = {
    getService: (t: string) =>
      t === NotificationPushService.serviceType ? service : null,
  };
  return { runtime, registry: service.getRegistry() };
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

const req = (url: string) => ({ url }) as http.IncomingMessage;
const res = {} as http.ServerResponse;
const PREFIX = "/api/notifications/push-tokens";

describe("handlePushTokenRoute", () => {
  let runtime: { getService: (t: string) => unknown };
  let registry: PushTokenRegistry;

  beforeEach(async () => {
    ({ runtime, registry } = await makeRuntimeWithService());
  });

  it("ignores non push-token paths", async () => {
    const helpers = makeHelpers();
    const handled = await handlePushTokenRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(handled).toBe(false);
  });

  it("POST registers a token (201) and persists it", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      platform: "ios",
      token: "tok-1",
    });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true }, 201);
    expect(await registry.count()).toBe(1);
    expect((await registry.list())[0]).toMatchObject({
      token: "tok-1",
      platform: "ios",
    });
  });

  it("POST rejects an invalid platform with 400", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({ platform: "web", token: "x" });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 400);
    expect(await registry.count()).toBe(0);
  });

  it("POST rejects a missing token with 400", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      platform: "android",
      token: "  ",
    });
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 400);
  });

  it("GET returns count + per-platform breakdown", async () => {
    await registry.register("ios", "i1");
    await registry.register("ios", "i2");
    await registry.register("android", "a1");
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, {
      count: 3,
      platforms: { ios: 2, android: 1 },
    });
  });

  it("DELETE :token unregisters and reports existence", async () => {
    await registry.register("ios", "tok-del");
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(`${PREFIX}/tok-del`),
      res,
      `${PREFIX}/tok-del`,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(await registry.count()).toBe(0);
  });

  it("DELETE :token returns ok:false for an unknown token", async () => {
    const helpers = makeHelpers();
    await handlePushTokenRoute(
      req(`${PREFIX}/missing`),
      res,
      `${PREFIX}/missing`,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: false });
  });

  it("returns 503 when the push service is not registered", async () => {
    const helpers = makeHelpers();
    const emptyRuntime = { getService: () => null };
    await handlePushTokenRoute(
      req(PREFIX),
      res,
      PREFIX,
      "GET",
      { runtime: emptyRuntime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 503);
  });
});
