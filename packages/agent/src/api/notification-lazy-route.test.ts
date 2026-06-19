import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboxAndCloudRelayRouteGroup } from "./server-lazy-routes";

/**
 * Regression test for the lazy-route wrapper guard.
 *
 * `server.ts` dispatches `/api/notifications*` through the lazily-loaded
 * `handleInboxAndCloudRelayRouteGroup` wrapper. The wrapper gates which paths
 * are forwarded to the real dispatch module so it doesn't load the heavy
 * module for every request. When the notification routes were added to the
 * real dispatch, the wrapper's path guard still only allowed `/api/inbox` and
 * `/api/cloud/relay-status` — so `/api/notifications` (and `.../push-tokens`)
 * returned `false` and fell through to the server's 404. The unit tests for
 * the handlers called them directly and bypassed this guard; only an
 * on-device request surfaced it. This test exercises the wrapper itself so the
 * guard can't silently drop the notification namespace again.
 */
function makeContext(pathname: string, method = "GET") {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return {
    args: {
      req: { url: pathname } as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      url: new URL(pathname, "http://localhost"),
      // No runtime → the notification handler serves an empty inbox for GET,
      // which still proves the wrapper forwarded the request (returned true).
      state: { runtime: null },
      json,
      error,
      readJsonBody,
    },
    json,
    error,
  };
}

describe("handleInboxAndCloudRelayRouteGroup (lazy wrapper guard)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards /api/notifications to the dispatch (does not drop it)", async () => {
    const { args, json } = makeContext("/api/notifications");
    const handled = await handleInboxAndCloudRelayRouteGroup(
      args as unknown as Parameters<
        typeof handleInboxAndCloudRelayRouteGroup
      >[0],
    );
    expect(handled).toBe(true);
    expect(json).toHaveBeenCalledWith(args.res, {
      notifications: [],
      unreadCount: 0,
    });
  });

  it("forwards /api/notifications/push-tokens to the dispatch", async () => {
    const { args, error } = makeContext(
      "/api/notifications/push-tokens",
      "GET",
    );
    const handled = await handleInboxAndCloudRelayRouteGroup(
      args as unknown as Parameters<
        typeof handleInboxAndCloudRelayRouteGroup
      >[0],
    );
    // No runtime → push-token route reports "not ready" (503) but still
    // HANDLES the request, proving the wrapper forwarded it.
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(args.res, expect.any(String), 503);
  });

  it("still forwards /api/inbox", async () => {
    const { args } = makeContext("/api/inbox/messages");
    const handled = await handleInboxAndCloudRelayRouteGroup(
      args as unknown as Parameters<
        typeof handleInboxAndCloudRelayRouteGroup
      >[0],
    );
    expect(handled).toBe(true);
  });

  it("does NOT forward unrelated paths (guard still narrow)", async () => {
    const { args } = makeContext("/api/conversations");
    const handled = await handleInboxAndCloudRelayRouteGroup(
      args as unknown as Parameters<
        typeof handleInboxAndCloudRelayRouteGroup
      >[0],
    );
    expect(handled).toBe(false);
  });
});
