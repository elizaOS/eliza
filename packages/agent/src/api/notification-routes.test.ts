/**
 * Covers `handleNotificationRoute` — the `/api/notifications` surface (list,
 * create, mark-read, read-all, delete, clear, the dev-only seed, plus filter
 * query params) — driven against a real `NotificationService` over an
 * in-memory cache-backed fake runtime with mocked response helpers, including
 * the service-absent empty-inbox and 503 fallbacks.
 */
import type http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_SEED_NOTIFICATIONS,
  handleNotificationRoute,
} from "./notification-routes";

async function makeRuntimeWithService(): Promise<{
  runtime: { getService: (t: string) => unknown };
  service: NotificationService;
}> {
  const cache = new Map<string, unknown>();
  const bus = { emit: vi.fn() };
  const baseRuntime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string): Promise<boolean> => cache.delete(key),
    getService: (t: string) => (t === ServiceType.AGENT_EVENT ? bus : null),
  } as unknown as IAgentRuntime;
  const service = (await NotificationService.start(
    baseRuntime,
  )) as NotificationService;
  const runtime = {
    getService: (t: string) =>
      t === ServiceType.NOTIFICATION
        ? service
        : t === ServiceType.AGENT_EVENT
          ? bus
          : null,
  };
  return { runtime, service };
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody };
}

const req = (url: string) => ({ url }) as http.IncomingMessage;
const res = {} as http.ServerResponse;

describe("handleNotificationRoute", () => {
  let runtime: { getService: (t: string) => unknown };
  let service: NotificationService;

  beforeEach(async () => {
    ({ runtime, service } = await makeRuntimeWithService());
  });

  it("ignores non-notification paths", async () => {
    const helpers = makeHelpers();
    const handled = await handleNotificationRoute(
      req("/api/other"),
      res,
      "/api/other",
      "GET",
      { runtime },
      helpers,
    );
    expect(handled).toBe(false);
  });

  it("GET returns the inbox and unread count", async () => {
    await service.notify({ title: "Hello", category: "task" });
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledTimes(1);
    const payload = helpers.json.mock.calls[0][1] as {
      notifications: unknown[];
      unreadCount: number;
    };
    expect(payload.notifications).toHaveLength(1);
    expect(payload.unreadCount).toBe(1);
  });

  it("GET honors unreadOnly + category + limit filters", async () => {
    await service.notify({ title: "A", category: "task" });
    const b = await service.notify({ title: "B", category: "workflow" });
    await service.markRead(b.id);
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications?unreadOnly=true&category=task&limit=5"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    const payload = helpers.json.mock.calls[0][1] as {
      notifications: Array<{ title: string }>;
    };
    expect(payload.notifications.map((n) => n.title)).toEqual(["A"]);
  });

  it("POST creates a notification (201) via the service", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({
      title: "Created",
      category: "agent",
      priority: "high",
    });
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledTimes(1);
    expect(helpers.json.mock.calls[0][2]).toBe(201);
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0].priority).toBe("high");
  });

  it("POST rejects a missing title with 400", async () => {
    const helpers = makeHelpers();
    helpers.readJsonBody.mockResolvedValue({ body: "no title" });
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 400);
    expect(service.list()).toHaveLength(0);
  });

  it("POST :id/read marks one read", async () => {
    const n = await service.notify({ title: "Read me" });
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req(`/api/notifications/${n.id}/read`),
      res,
      `/api/notifications/${n.id}/read`,
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(service.getUnreadCount()).toBe(0);
  });

  it("POST read-all marks everything read", async () => {
    await service.notify({ title: "A" });
    await service.notify({ title: "B" });
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications/read-all"),
      res,
      "/api/notifications/read-all",
      "POST",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { changed: 2 });
    expect(service.getUnreadCount()).toBe(0);
  });

  it("DELETE :id removes one", async () => {
    const n = await service.notify({ title: "Remove me" });
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req(`/api/notifications/${n.id}`),
      res,
      `/api/notifications/${n.id}`,
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(service.list()).toHaveLength(0);
  });

  it("DELETE clears the inbox", async () => {
    await service.notify({ title: "A" });
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "DELETE",
      { runtime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, { ok: true });
    expect(service.list()).toHaveLength(0);
  });

  it("POST dev/seed paints the demo spread (groupKey pair collapses)", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const helpers = makeHelpers();
      await handleNotificationRoute(
        req("/api/notifications/dev/seed"),
        res,
        "/api/notifications/dev/seed",
        "POST",
        { runtime },
        helpers,
      );
      expect(helpers.json).toHaveBeenCalledTimes(1);
      const [, payload, status] = helpers.json.mock.calls[0] as [
        unknown,
        { count: number; notifications: Array<{ priority: string }> },
        number,
      ];
      expect(status).toBe(201);
      expect(payload.count).toBe(DEV_SEED_NOTIFICATIONS.length);
      // Every priority tier is represented in the seed.
      const priorities = new Set(payload.notifications.map((n) => n.priority));
      expect(priorities).toEqual(new Set(["low", "normal", "high", "urgent"]));
      // The same-groupKey pair collapsed: the inbox holds one fewer row than
      // the seed emitted, and only the later deploy update survives.
      const inbox = service.list();
      expect(inbox).toHaveLength(DEV_SEED_NOTIFICATIONS.length - 1);
      const deploys = inbox.filter((n) => n.groupKey === "dev-seed:deploy");
      expect(deploys).toHaveLength(1);
      expect(deploys[0].body).toContain("Step 5/5");
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("POST dev/seed is hidden (404) in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const helpers = makeHelpers();
      await handleNotificationRoute(
        req("/api/notifications/dev/seed"),
        res,
        "/api/notifications/dev/seed",
        "POST",
        { runtime },
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 404);
      expect(service.list()).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("GET serves an empty inbox when the service is not registered", async () => {
    const helpers = makeHelpers();
    const emptyRuntime = { getService: () => null };
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "GET",
      { runtime: emptyRuntime },
      helpers,
    );
    expect(helpers.json).toHaveBeenCalledWith(res, {
      notifications: [],
      unreadCount: 0,
    });
  });

  it("returns 503 for mutations when the service is not registered", async () => {
    const helpers = makeHelpers();
    const emptyRuntime = { getService: () => null };
    await handleNotificationRoute(
      req("/api/notifications"),
      res,
      "/api/notifications",
      "POST",
      { runtime: emptyRuntime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, expect.any(String), 503);
  });
});
