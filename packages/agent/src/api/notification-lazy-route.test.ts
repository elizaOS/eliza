/**
 * Drives the lazy-route wrapper `handleInboxAndCloudRelayRouteGroup` directly
 * (mocked req/res/helpers, no live server) to prove its path guard forwards
 * the `/api/notifications` namespace and `/api/inbox` to the real dispatch
 * while still rejecting unrelated paths.
 */
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboxAndCloudRelayRouteGroup } from "./server-lazy-routes";

/**
 * `server.ts` dispatches `/api/notifications*` through the lazily-loaded
 * `handleInboxAndCloudRelayRouteGroup` wrapper, whose path guard decides which
 * requests reach the heavy dispatch module. Handler-level unit tests call the
 * handlers directly and bypass that guard, so this test drives the wrapper
 * itself to ensure it keeps forwarding the notification namespace rather than
 * dropping it to a 404.
 */
function makeContext(pathname: string, method = "GET") {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  const setHeader = vi.fn();
  return {
    args: {
      req: { url: pathname } as http.IncomingMessage,
      res: { setHeader } as unknown as http.ServerResponse,
      method,
      pathname,
      url: new URL(pathname, "http://localhost"),
      // No runtime → the notification handler fails closed with a retryable 503
      // (it does not fabricate an empty inbox), which still proves the wrapper
      // forwarded the request (returned true).
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
    // No runtime → the dispatch fails closed with a retryable 503 rather than
    // fabricating an empty inbox; the wrapper still forwarded (handled === true).
    expect(json).toHaveBeenCalledWith(
      args.res,
      {
        error: "Notification service is still starting",
        code: "NOTIFICATION_SERVICE_NOT_READY",
        retryAfter: 1,
      },
      503,
    );
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
