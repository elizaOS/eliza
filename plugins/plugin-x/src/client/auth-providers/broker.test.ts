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
  vi.restoreAllMocks();
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
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("times out a hung broker token hop instead of waiting forever", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(
          Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }),
        );
      }, 50);
      return controller.signal;
    });
    const fetchMock = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BrokerAuthProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    const started = performance.now();
    try {
      await provider.getAccessToken();
      expect.unreachable("hung broker fetch should fail closed");
    } catch (error) {
      expect((error as Error).name).toBe("TimeoutError");
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.eliza.app/api/v1/twitter/token?connectionRole=agent",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it("can use the owner's X connection for a personal agent", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        auth_mode: "oauth2",
        access_token: "owner-oauth-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BrokerAuthProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "personal-agent-key",
        TWITTER_BROKER_CONNECTION_ROLE: "owner",
      }),
    );

    await expect(provider.getAccessToken()).resolves.toBe("owner-oauth-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.eliza.app/api/v1/twitter/token?connectionRole=owner",
      expect.any(Object),
    );
  });

  it("rejects an unknown broker connection role", async () => {
    const provider = new BrokerAuthProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "agent-cloud-key",
        TWITTER_BROKER_CONNECTION_ROLE: "team",
      }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Expected agent|owner",
    );
  });
});
