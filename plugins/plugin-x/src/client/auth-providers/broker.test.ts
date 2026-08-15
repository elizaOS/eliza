/**
 * Exercises managed X broker authentication with deterministic HTTP responses,
 * including the agent-role route and credential caching contract.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrokerAuthProvider } from "./broker";

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BrokerAuthProvider", () => {
  it("vends and caches the connected agent-role OAuth2 token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        auth_mode: "oauth2",
        access_token: "oauth-user-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BrokerAuthProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "agent-cloud-key",
        TWITTER_BROKER_URL: "https://cloud.eliza.app/api/v1/twitter/",
      }),
    );

    await expect(provider.getAccessToken()).resolves.toBe("oauth-user-token");
    await expect(provider.getBrokerCredentials()).resolves.toEqual({
      mode: "oauth2",
      accessToken: "oauth-user-token",
    });
    await expect(provider.getAccessToken()).resolves.toBe("oauth-user-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.eliza.app/api/v1/twitter/token?connectionRole=agent",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer agent-cloud-key",
        }),
      }),
    );
  });

  it("fails closed when the broker returns an invalid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true })),
    );
    const provider = new BrokerAuthProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker returned an invalid credential response",
    );
  });
});
