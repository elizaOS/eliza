import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerAuthProvider } from "../auth-providers/broker";

function makeRuntime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("BrokerAuthProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("throws if TWITTER_BROKER_URL is missing", async () => {
    const provider = new BrokerAuthProvider(makeRuntime({}));
    await expect(provider.getAccessToken()).rejects.toThrow(
      "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_URL",
    );
  });

  it("throws a clear error when broker token is missing", async () => {
    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://api.eliza.cloud/connectors/x",
      }),
    );
    await expect(provider.getAccessToken()).rejects.toThrow(
      /TWITTER_BROKER_TOKEN/,
    );
  });

  it("calls the broker /token endpoint with the bearer token and returns OAuth2 access_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          auth_mode: "oauth2",
          access_token: "x-access-1",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://api.eliza.cloud/connectors/x",
        TWITTER_BROKER_TOKEN: "broker-tok",
      }),
    );

    const token = await provider.getAccessToken();
    expect(token).toBe("x-access-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.eliza.cloud/connectors/x/token");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer broker-tok",
    });
  });

  it("caches OAuth2 tokens until expires_at − 60s", async () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            auth_mode: "oauth2",
            access_token: "x-access-1",
            expires_at: Math.floor(now / 1000) + 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://example.test",
        TWITTER_BROKER_TOKEN: "tok",
      }),
    );

    await provider.getAccessToken();
    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(now + 3600 * 1000); // past refresh margin
    await provider.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns OAuth1 credentials when broker reports oauth1 mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          auth_mode: "oauth1",
          consumer_key: "ck",
          consumer_secret: "cs",
          access_token: "at",
          access_token_secret: "ats",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://example.test",
        TWITTER_BROKER_TOKEN: "tok",
      }),
    );

    const creds = await provider.getOAuth1Credentials();
    expect(creds).toEqual({
      appKey: "ck",
      appSecret: "cs",
      accessToken: "at",
      accessSecret: "ats",
    });
  });

  it("invalidates cache and surfaces a 401 error message", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("unauthorized", { status: 401 }),
      ) as unknown as typeof fetch;

    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://example.test",
        TWITTER_BROKER_TOKEN: "tok",
      }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      /broker token.*401/i,
    );
  });

  it("rejects unrecognised response shapes", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const provider = new BrokerAuthProvider(
      makeRuntime({
        TWITTER_BROKER_URL: "https://example.test",
        TWITTER_BROKER_TOKEN: "tok",
      }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      /unrecognised token response/i,
    );
  });
});
