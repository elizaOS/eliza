import { afterEach, describe, expect, it, vi } from "vitest";
import { type FeedConfig, proxyFeedRequest } from "./feed-auth";

function baseConfig(overrides: Partial<FeedConfig> = {}): FeedConfig {
  return {
    apiBaseUrl: "http://feed.test",
    agentId: "agent-1",
    agentSecret: "agent-secret-value-at-least-32-characters",
    stewardToken: undefined,
    runtime: null,
    ...overrides,
  };
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxyFeedRequest — Steward-first auto-login", () => {
  it("forwards the agent's Steward JWT as Bearer and skips /api/agents/auth", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const res = await proxyFeedRequest(
      baseConfig({ stewardToken: "steward-jwt" }),
      "GET",
      "/api/posts",
    );

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/posts");
    expect(authHeader(init)).toBe("Bearer steward-jwt");
    // No agent-session exchange happened.
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).includes("/api/agents/auth"),
      ),
    ).toBe(false);
    // Dead cookie removed.
    expect((init?.headers as Record<string, string>).Cookie).toBeUndefined();
  });

  it("falls back to the agent-session path when the Steward JWT is rejected (401)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const u = String(url);
        if (u.includes("/api/agents/auth")) {
          return new Response(
            JSON.stringify({
              sessionToken: "agent-session-token",
              expiresIn: 600,
            }),
            { status: 200 },
          );
        }
        // Proxied request: reject the steward token, accept the session token.
        if (authHeader(init) === "Bearer steward-bad") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

    const res = await proxyFeedRequest(
      baseConfig({ stewardToken: "steward-bad" }),
      "GET",
      "/api/posts",
    );

    expect(res.status).toBe(200);
    // The agent-session exchange was used as fallback.
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).includes("/api/agents/auth"),
      ),
    ).toBe(true);
    // Final proxied request carried the agent session token.
    const finalCall = fetchSpy.mock.calls.at(-1);
    expect(authHeader(finalCall?.[1])).toBe("Bearer agent-session-token");
  });
});
