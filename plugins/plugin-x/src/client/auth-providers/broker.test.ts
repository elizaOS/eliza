/**
 * Exercises managed X broker authentication with deterministic HTTP responses,
 * including the agent-role route and credential caching contract.
 */
import type {
  GuardedFetchOptions,
  GuardedFetchResult,
  IAgentRuntime,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_FETCH_TIMEOUT_MS,
  BROKER_RESPONSE_MAX_BYTES,
  BrokerAuthProvider,
} from "./broker";

function runtime(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

async function testGuardedFetch(
  params: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const response = await fetch(params.url, {
    ...params.init,
    redirect: "error",
    signal: params.signal,
  });
  return { response, finalUrl: params.url, release: async () => undefined };
}

function newTestProvider(runtimeValue: IAgentRuntime): BrokerAuthProvider {
  return new BrokerAuthProvider(runtimeValue, testGuardedFetch);
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
    const provider = newTestProvider(
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
        redirect: "error",
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
    const provider = newTestProvider(
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
      "https://api.eliza.app/api/v1/twitter/token?connectionRole=agent",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("fails closed when the broker returns an invalid response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true })),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker returned an invalid credential response",
    );
  });

  it("rebuilds OAuth1 credentials from only allowlisted bounded fields", async () => {
    const raw = {
      auth_mode: "oauth1",
      consumer_key: "consumer-key",
      consumer_secret: "consumer-secret",
      access_token: "access-token",
      access_token_secret: "access-secret",
      refresh_token: "must-not-survive",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(raw)),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getBrokerCredentials()).resolves.toEqual({
      mode: "oauth1",
      appKey: "consumer-key",
      appSecret: "consumer-secret",
      accessToken: "access-token",
      accessSecret: "access-secret",
    });
    raw.access_token = "mutated-after-fetch";
    await expect(provider.getAccessToken()).resolves.toBe("access-token");
  });

  it("rejects oversized declared responses before reading the body", async () => {
    const body = {
      cancel: vi.fn(async () => undefined),
      getReader: vi.fn(),
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body,
            headers: new Headers({
              "content-length": String(BROKER_RESPONSE_MAX_BYTES + 1),
            }),
          }) as Response,
      ),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker response exceeded the size limit",
    );
    expect(body.getReader).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response once its cumulative size is exceeded", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(9 * 1024));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker response exceeded the size limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects invalid lengths, malformed UTF-8, and malformed JSON without reflection", async () => {
    const secret = "broker-secret-that-must-not-escape";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", { headers: { "content-length": "+2" } }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([0xc3, 0x28])))
      .mockResolvedValueOnce(new Response(`{"access_token":"${secret}"`));
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker returned an invalid response",
    );
    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker returned an invalid response",
    );
    await expect(provider.getAccessToken()).rejects.not.toThrow(secret);
  });

  it("accepts a standards-valid zero-padded content length", async () => {
    const payload = JSON.stringify({
      auth_mode: "oauth2",
      access_token: "token",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(payload, {
            headers: {
              "content-length": String(payload.length).padStart(5, "0"),
            },
          }),
      ),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).resolves.toBe("token");
  });

  it("does not read or reflect non-success response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = {
      cancel,
      getReader: vi.fn(() => {
        throw new Error("secret error body was read");
      }),
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 500, ok: false, body }) as Response),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "X broker request failed (500)",
    );
    expect(body.getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes transport errors and preserves the authoritative timeout", async () => {
    const leaked = "https://secret.example/?token=credential";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(leaked);
      }),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    const failure = await provider.getAccessToken().catch((error) => error);
    expect(failure.message).toBe("X broker request failed");
    expect(String(failure.cause)).not.toContain(leaked);

    const controller = new AbortController();
    const timeout = new DOMException("broker deadline", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise<void>(() => undefined);
              },
            }),
          ),
      ),
    );
    const timedProvider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    const pending = timedProvider.getAccessToken();
    controller.abort(timeout);
    await expect(pending).rejects.toBe(timeout);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(BROKER_FETCH_TIMEOUT_MS);
  });

  it("does not mask a timeout that fires after body reading has started", async () => {
    const controller = new AbortController();
    const timeout = new DOMException("body deadline", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let markPullStarted!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      markPullStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                markPullStarted();
                return new Promise<void>(() => undefined);
              },
            }),
          ),
      ),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    const pending = provider.getAccessToken();
    await pullStarted;
    controller.abort(timeout);
    await expect(pending).rejects.toBe(timeout);
  });

  it("rejects overlong secrets and invalid expiry timestamps", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            auth_mode: "oauth2",
            access_token: "x".repeat(8 * 1024 + 1),
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            auth_mode: "oauth2",
            access_token: "token",
            expires_at: 1.5,
          }),
        ),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    await expect(provider.getAccessToken()).rejects.toThrow(
      "invalid credential response",
    );
    await expect(provider.getAccessToken()).rejects.toThrow(
      "invalid credential response",
    );
  });

  it("coalesces concurrent fetches and retries after a shared failure", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
      )
      .mockRejectedValueOnce(new Error("private failure"))
      .mockResolvedValueOnce(
        Response.json({ auth_mode: "oauth2", access_token: "replacement" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );
    const first = provider.getAccessToken();
    const second = provider.getBrokerCredentials();
    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(
      Response.json({ auth_mode: "oauth2", access_token: "shared-token" }),
    );
    await expect(Promise.all([first, second])).resolves.toEqual([
      "shared-token",
      { mode: "oauth2", accessToken: "shared-token" },
    ]);

    provider.invalidate();
    const failed = await Promise.allSettled([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    await expect(provider.getAccessToken()).resolves.toBe("replacement");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("can use the owner's X connection for a personal agent", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        auth_mode: "oauth2",
        access_token: "owner-oauth-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "personal-agent-key",
        TWITTER_BROKER_CONNECTION_ROLE: "owner",
      }),
    );

    await expect(provider.getAccessToken()).resolves.toBe("owner-oauth-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/v1/twitter/token?connectionRole=owner",
      expect.any(Object),
    );
  });

  it("rejects an unknown broker connection role", async () => {
    const provider = newTestProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "agent-cloud-key",
        TWITTER_BROKER_CONNECTION_ROLE: "team",
      }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Expected agent|owner",
    );
  });

  it.each([
    "http://cloud.eliza.app/api/v1/twitter",
    "https://user:secret@cloud.eliza.app/api/v1/twitter",
    "https://cloud.eliza.app/api/v1/twitter?forward=https://127.0.0.1",
    "https://cloud.eliza.app/api/v1/twitter#fragment",
    "https://127.0.0.1/api/v1/twitter",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/computeMetadata/v1",
    "not a URL",
  ])("rejects unsafe broker URL %s before sending credentials", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "agent-cloud-key",
        TWITTER_BROKER_URL: url,
      }),
    );

    await expect(provider.getAccessToken()).rejects.toThrow(
      "Invalid X broker URL",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends the privileged Cloud key to a custom public broker origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({
        ELIZAOS_CLOUD_API_KEY: "privileged-cloud-key",
        TWITTER_BROKER_URL: "https://broker.example/api/v1/twitter",
      }),
    );

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "X_BROKER_CREDENTIAL_MISSING",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes production requests through the SSRF guard with redirects disabled", async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn(
      async (): Promise<GuardedFetchResult> => ({
        response: Response.json({
          auth_mode: "oauth2",
          access_token: "guarded",
        }),
        finalUrl:
          "https://api.eliza.app/api/v1/twitter/token?connectionRole=agent",
        release,
      }),
    );
    const provider = new BrokerAuthProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
      guardedFetch,
    );

    await expect(provider.getAccessToken()).resolves.toBe("guarded");
    expect(guardedFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.eliza.app/api/v1/twitter/token?connectionRole=agent",
        maxRedirects: 0,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects control characters and oversized outbound broker credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const token of [
      "secret\r\ninjected: true",
      "x".repeat(8 * 1024 + 1),
    ]) {
      const provider = newTestProvider(
        runtime({ TWITTER_BROKER_TOKEN: token }),
      );
      await expect(provider.getAccessToken()).rejects.toThrow(
        "Invalid X broker credential",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects control characters in broker-returned credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          auth_mode: "oauth2",
          access_token: "secret\r\ninjected: true",
        }),
      ),
    );
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "X_BROKER_RESPONSE_INVALID",
    });
  });

  it("re-fetches when the live connection role changes", async () => {
    const settings: Record<string, string> = {
      ELIZAOS_CLOUD_API_KEY: "agent-cloud-key",
      TWITTER_BROKER_CONNECTION_ROLE: "agent",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ auth_mode: "oauth2", access_token: "agent-token" }),
      )
      .mockResolvedValueOnce(
        Response.json({ auth_mode: "oauth2", access_token: "owner-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(runtime(settings));

    await expect(provider.getAccessToken()).resolves.toBe("agent-token");
    settings.TWITTER_BROKER_CONNECTION_ROLE = "owner";
    await expect(provider.getAccessToken()).resolves.toBe("owner-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalidated flight and admits later callers only to a new generation", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      )
      .mockResolvedValueOnce(
        Response.json({ auth_mode: "oauth2", access_token: "fresh-token" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = newTestProvider(
      runtime({ ELIZAOS_CLOUD_API_KEY: "agent-cloud-key" }),
    );

    const staleRequest = provider.getAccessToken();
    provider.invalidate();
    const freshRequest = provider.getAccessToken();
    await expect(staleRequest).rejects.toMatchObject({ name: "AbortError" });
    await expect(freshRequest).resolves.toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
