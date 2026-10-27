/** Exercises Android notification-list boolean validation through the UDS route harness. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type AndroidDispatchRoute,
  dispatchBufferedRequest,
} from "./dispatch.ts";

function notifierRuntime(
  list: (query?: { unreadOnly?: boolean }) => unknown[],
): IAgentRuntime {
  return {
    getService: (type: string) =>
      type === "notification"
        ? {
            list,
            getUnreadCount: () => 0,
            markRead: () => Promise.resolve(true),
            markAllRead: () => Promise.resolve(0),
            remove: () => Promise.resolve(true),
            clear: () => Promise.resolve(),
          }
        : null,
  } as unknown as IAgentRuntime;
}

const fallthrough: AndroidDispatchRoute = async () => null;

describe("GET /api/notifications unreadOnly identity", () => {
  it.each(["/api/notifications", "/api/notifications?unreadOnly="])(
    "accepts %s as the full inbox",
    async (path) => {
      const calls: Array<{ unreadOnly?: boolean } | undefined> = [];
      const runtime = notifierRuntime((query) => {
        calls.push(query);
        return [];
      });
      const response = await dispatchBufferedRequest(runtime, fallthrough, {
        method: "GET",
        path,
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual([
        { unreadOnly: false, category: undefined, limit: undefined },
      ]);
    },
  );

  it("accepts unreadOnly=true as the unread-only inbox", async () => {
    const calls: Array<{ unreadOnly?: boolean } | undefined> = [];
    const runtime = notifierRuntime((query) => {
      calls.push(query);
      return [];
    });
    const response = await dispatchBufferedRequest(runtime, fallthrough, {
      method: "GET",
      path: "/api/notifications?unreadOnly=true",
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.unreadOnly).toBe(true);
  });

  it("accepts unreadOnly=false as the full inbox", async () => {
    const calls: Array<{ unreadOnly?: boolean } | undefined> = [];
    const runtime = notifierRuntime((query) => {
      calls.push(query);
      return [];
    });
    const response = await dispatchBufferedRequest(runtime, fallthrough, {
      method: "GET",
      path: "/api/notifications?unreadOnly=false",
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.unreadOnly).toBe(false);
  });

  it.each(["TRUE", "FALSE", "1", "0", "yes", "no", "foo", "1e2"])(
    "rejects unreadOnly=%s before list",
    async (token) => {
      const list = () => {
        throw new Error("list must not run");
      };
      const runtime = notifierRuntime(list);
      const response = await dispatchBufferedRequest(runtime, fallthrough, {
        method: "GET",
        path: `/api/notifications?unreadOnly=${encodeURIComponent(token)}`,
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "Invalid unreadOnly",
      });
    },
  );

  it.each([
    "/api/notifications?unreadOnly=true&unreadOnly=true",
    "/api/notifications?unreadOnly=true&unreadOnly=false",
    "/api/notifications?unreadOnly=&unreadOnly=true",
    "/api/notifications?unreadOnly=foo&unreadOnly=true",
  ])("rejects duplicate unreadOnly values in %s before list", async (path) => {
    const list = () => {
      throw new Error("list must not run");
    };
    const runtime = notifierRuntime(list);
    const response = await dispatchBufferedRequest(runtime, fallthrough, {
      method: "GET",
      path,
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid unreadOnly" });
  });
});

describe("GET /api/notifications limit identity", () => {
  const recorded = () => {
    const calls: Array<{ limit?: number } | undefined> = [];
    const runtime = notifierRuntime((query) => {
      calls.push(query as { limit?: number } | undefined);
      return [];
    });
    return { calls, runtime };
  };

  it.each(["1e2", "-1", "abc", "10.5", "1,2", "%2010", "+5", "00"])(
    "rejects limit=%s before list",
    async (token) => {
      const list = () => {
        throw new Error("list must not run");
      };
      const runtime = notifierRuntime(list);
      const response = await dispatchBufferedRequest(runtime, fallthrough, {
        method: "GET",
        path: `/api/notifications?limit=${token}`,
      });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "Invalid limit" });
    },
  );

  it("rejects duplicate limit values before list", async () => {
    const list = () => {
      throw new Error("list must not run");
    };
    const runtime = notifierRuntime(list);
    const response = await dispatchBufferedRequest(runtime, fallthrough, {
      method: "GET",
      path: "/api/notifications?limit=10&limit=20",
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid limit" });
  });

  it("passes a canonical page size to list and clamps the maximum", async () => {
    const small = recorded();
    expect(
      (
        await dispatchBufferedRequest(small.runtime, fallthrough, {
          method: "GET",
          path: "/api/notifications?limit=10",
        })
      ).status,
    ).toBe(200);
    expect(small.calls[0]?.limit).toBe(10);

    const large = recorded();
    expect(
      (
        await dispatchBufferedRequest(large.runtime, fallthrough, {
          method: "GET",
          path: "/api/notifications?limit=5000",
        })
      ).status,
    ).toBe(200);
    expect(large.calls[0]?.limit).toBe(500);
  });

  it("keeps limit=0 for a count-only inbox read", async () => {
    const zero = recorded();
    const response = await dispatchBufferedRequest(zero.runtime, fallthrough, {
      method: "GET",
      path: "/api/notifications?limit=0",
    });
    expect(response.status).toBe(200);
    expect(zero.calls[0]?.limit).toBe(0);
  });
});
