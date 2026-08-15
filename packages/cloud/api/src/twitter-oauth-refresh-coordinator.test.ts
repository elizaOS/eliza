/**
 * Deterministic Durable Object boundary coverage for X credential refresh
 * serialization. The broker is injected; no provider or database is mocked as
 * the system under test is the cross-request coordinator itself.
 */

import { describe, expect, mock, test } from "bun:test";
import type { TwitterBrokerCredentials } from "@/lib/services/twitter-automation";
import type { AppEnv } from "@/types/cloud-worker-env";
import { TwitterOAuthRefreshCoordinator } from "./twitter-oauth-refresh-coordinator";

function request(role: "agent" | "owner" = "agent"): Request {
  return new Request("https://twitter-oauth.internal/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-1",
      userId: "user-1",
      connectionRole: role,
    }),
  });
}

describe("TwitterOAuthRefreshCoordinator", () => {
  test("serializes concurrent requests for one Durable Object instance", async () => {
    let active = 0;
    let maxActive = 0;
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let calls = 0;
    let providerRefreshes = 0;
    let fresh = false;
    const getBrokerCredentials = mock(
      async (): Promise<TwitterBrokerCredentials> => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (!fresh) {
          providerRefreshes += 1;
          markFirstEntered();
          await firstBlocked;
          fresh = true;
        }
        active -= 1;
        return {
          authMode: "oauth2",
          accessToken: "fresh-token",
          expiresAt: 123,
          scope: "tweet.read",
          twitterUserId: "x-user",
        };
      },
    );
    const object = new TwitterOAuthRefreshCoordinator(
      {} as DurableObjectState,
      {} as AppEnv["Bindings"],
      { getBrokerCredentials },
    );

    const first = object.fetch(request());
    const second = object.fetch(request());
    await firstEntered;
    expect(calls).toBe(1);
    releaseFirst();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(maxActive).toBe(1);
    expect(calls).toBe(2);
    expect(providerRefreshes).toBe(1);
    const secondBody = (await secondResponse.json()) as Record<string, unknown>;
    expect(secondBody).toEqual({
      auth_mode: "oauth2",
      access_token: "fresh-token",
      expires_at: 123,
      scopes: "tweet.read",
      user_id: "x-user",
    });
  });

  test("rejects malformed internal requests before reaching the broker", async () => {
    const getBrokerCredentials = mock(
      async (): Promise<TwitterBrokerCredentials> => null,
    );
    const object = new TwitterOAuthRefreshCoordinator(
      {} as DurableObjectState,
      {} as AppEnv["Bindings"],
      { getBrokerCredentials },
    );
    const response = await object.fetch(
      new Request("https://twitter-oauth.internal/credentials", {
        method: "POST",
        body: JSON.stringify({
          organizationId: "org-1",
          connectionRole: "agent",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(getBrokerCredentials).not.toHaveBeenCalled();
  });
});
