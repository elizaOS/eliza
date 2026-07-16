/**
 * Unit coverage for notification client contracts, including the explicit
 * disabled-inbox response and push-token verbs. Transport stubbed; no live
 * agent.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-notifications";

describe("ElizaClient push-token verbs", () => {
  it("preserves the explicit disabled inbox status from the list response", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const response = {
      notifications: [],
      unreadCount: 0,
      serviceStatus: "disabled" as const,
    };
    const fetch = vi.fn(async () => response);
    client.fetch = fetch as typeof client.fetch;

    await expect(client.listNotifications({ limit: 100 })).resolves.toEqual(
      response,
    );
    expect(fetch).toHaveBeenCalledWith("/api/notifications?limit=100");
  });

  it("POSTs the platform + token to /api/notifications/push-tokens", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({ ok: true }));
    client.fetch = fetch as typeof client.fetch;

    const result = await client.registerPushToken("ios", "apns-hex-token");

    expect(fetch).toHaveBeenCalledWith("/api/notifications/push-tokens", {
      method: "POST",
      body: JSON.stringify({ platform: "ios", token: "apns-hex-token" }),
    });
    expect(result).toEqual({ ok: true });
  });

  it("registers android (FCM) tokens under the android platform", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({ ok: true }));
    client.fetch = fetch as typeof client.fetch;

    await client.registerPushToken("android", "fcm-registration-token");

    expect(fetch).toHaveBeenCalledWith("/api/notifications/push-tokens", {
      method: "POST",
      body: JSON.stringify({
        platform: "android",
        token: "fcm-registration-token",
      }),
    });
  });

  it("DELETEs the URL-encoded token on unregister", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({ ok: true }));
    client.fetch = fetch as typeof client.fetch;

    // A token with a slash must be percent-encoded so it stays one path segment.
    await client.unregisterPushToken("tok/with+slash");

    expect(fetch).toHaveBeenCalledWith(
      "/api/notifications/push-tokens/tok%2Fwith%2Bslash",
      { method: "DELETE" },
    );
  });
});
