/** Exercises notification-list boolean validation through the HTTP route harness. */
import type http from "node:http";
import type {
  IAgentRuntime,
  NotificationServiceLifecycleRuntime,
} from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotificationRoute } from "./notification-routes";

async function makeRuntimeWithService(): Promise<{
  runtime: NotificationServiceLifecycleRuntime;
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
    reportError: vi.fn(),
    getService: (t: string) =>
      t === ServiceType.NOTIFICATION
        ? service
        : t === ServiceType.AGENT_EVENT
          ? bus
          : null,
    hasService: (t: string) => t === ServiceType.NOTIFICATION,
    getServiceRegistrationStatus: () => "registered" as const,
    getServiceLoadPromise: async () => service,
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
const setHeader = vi.fn();
const res = { setHeader } as unknown as http.ServerResponse;

describe("GET /api/notifications unreadOnly identity", () => {
  let runtime: NotificationServiceLifecycleRuntime;
  let service: NotificationService;

  beforeEach(async () => {
    setHeader.mockReset();
    ({ runtime, service } = await makeRuntimeWithService());
    const unread = await service.notify({ title: "Unread" });
    const read = await service.notify({ title: "Read" });
    await service.markRead(read.id);
    expect(unread.title).toBe("Unread");
  });

  it.each(["/api/notifications", "/api/notifications?unreadOnly="])(
    "accepts %s as the full inbox",
    async (url) => {
      const helpers = makeHelpers();
      const list = vi.spyOn(service, "list");
      await handleNotificationRoute(
        req(url),
        res,
        "/api/notifications",
        "GET",
        { runtime },
        helpers,
      );
      expect(helpers.error).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ unreadOnly: false }),
      );
      const payload = helpers.json.mock.calls[0][1] as {
        notifications: Array<{ title: string }>;
      };
      expect(payload.notifications.map((n) => n.title).sort()).toEqual([
        "Read",
        "Unread",
      ]);
    },
  );

  it("accepts unreadOnly=false as the full inbox", async () => {
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications?unreadOnly=false"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.error).not.toHaveBeenCalled();
    const payload = helpers.json.mock.calls[0][1] as {
      notifications: Array<{ title: string }>;
    };
    expect(payload.notifications.map((n) => n.title).sort()).toEqual([
      "Read",
      "Unread",
    ]);
  });

  it("accepts unreadOnly=true as unread-only", async () => {
    const helpers = makeHelpers();
    await handleNotificationRoute(
      req("/api/notifications?unreadOnly=true"),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.error).not.toHaveBeenCalled();
    const payload = helpers.json.mock.calls[0][1] as {
      notifications: Array<{ title: string }>;
    };
    expect(payload.notifications.map((n) => n.title)).toEqual(["Unread"]);
  });

  it.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects unreadOnly=%s before list",
    async (token) => {
      const helpers = makeHelpers();
      const list = vi.spyOn(service, "list");
      await handleNotificationRoute(
        req(
          `/api/notifications?unreadOnly=${encodeURIComponent(token)}&category=task&limit=5`,
        ),
        res,
        "/api/notifications",
        "GET",
        { runtime },
        helpers,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        res,
        "Invalid unreadOnly",
        400,
      );
      expect(helpers.json).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/api/notifications?unreadOnly=true&unreadOnly=true",
    "/api/notifications?unreadOnly=true&unreadOnly=false",
    "/api/notifications?unreadOnly=&unreadOnly=true",
    "/api/notifications?unreadOnly=foo&unreadOnly=true",
  ])("rejects duplicate unreadOnly values in %s before list", async (url) => {
    const helpers = makeHelpers();
    const list = vi.spyOn(service, "list");
    await handleNotificationRoute(
      req(url),
      res,
      "/api/notifications",
      "GET",
      { runtime },
      helpers,
    );
    expect(helpers.error).toHaveBeenCalledWith(res, "Invalid unreadOnly", 400);
    expect(helpers.json).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
