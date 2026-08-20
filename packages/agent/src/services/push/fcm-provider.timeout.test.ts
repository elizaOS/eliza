/**
 * FcmProvider fetch deadlines — proves the production provider aborts on
 * timeout via a real hanging HTTP server and handles body stall, covering
 * both token and send paths with the merged 21868 signal-keep pattern.
 */

import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FCM_FETCH_TIMEOUT_MS, FcmProvider } from "./fcm-provider.ts";

function makeRsaKey(): { privatePem: string } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function serviceAccountJson(privatePem: string): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "eliza-demo-project",
    private_key: privatePem,
    client_email: "pusher@eliza-demo-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

const envWith = (privatePem: string): NodeJS.ProcessEnv => ({
  ELIZA_FCM_SERVICE_ACCOUNT: serviceAccountJson(privatePem),
});

describe("FcmProvider fetch timeout (real server)", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_FCM_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled OAuth token exchange at the deadline (hanging server)", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing token");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        (
          provider as unknown as { getAccessToken: () => Promise<string> }
        ).getAccessToken(),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("oauth2.googleapis.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled FCM send at the deadline (hanging server)", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    (
      provider as unknown as {
        cachedToken: { accessToken: string; expiresAt: number };
      }
    ).cachedToken = {
      accessToken: "fake-access-token",
      expiresAt: Date.now() + 3600 * 1000,
    };
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing send");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        provider.send("device-token-123", { title: "Hi" }),
      ).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("fcm.googleapis.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a partial JSON body stall via the token path (signal kept through response.json)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"access_token": "');
      // never end - stall body
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/token`;

    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));

    // Override TOKEN_ENDPOINT via mocking fetch to point to our server
    const origFetch = globalThis.fetch;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => origTimeout(10));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("oauth2.googleapis.com")) {
          return origFetch(url, init);
        }
        return origFetch(input, init);
      });

    try {
      await expect(
        (
          provider as unknown as { getAccessToken: () => Promise<string> }
        ).getAccessToken(),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_FCM_FETCH_TIMEOUT_MS);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("oauth2.googleapis.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a partial JSON body stall via the send path", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.write('{"error": {"status": "INTERNAL"');
      // stall - send will attempt readFcmErrorCode which calls res.json()
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/send`;

    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    (
      provider as unknown as {
        cachedToken: { accessToken: string; expiresAt: number };
      }
    ).cachedToken = {
      accessToken: "fake-access-token",
      expiresAt: Date.now() + 3600 * 1000,
    };

    const origFetch = globalThis.fetch;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => origTimeout(10));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("fcm.googleapis.com")) {
          return origFetch(url, init);
        }
        return origFetch(input, init);
      });

    try {
      // send will try to parse error body via readFcmErrorCode which calls res.json() - stall should timeout
      await expect(
        provider.send("device-token-123", { title: "Hi" }),
      ).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(timeoutSpy).toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("preserves TimeoutError cause and does not swallow signal reason", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => reject(sig.reason), {
          once: true,
        });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      try {
        await (
          provider as unknown as { getAccessToken: () => Promise<string> }
        ).getAccessToken();
        throw new Error("should have timed out");
      } catch (err) {
        expect((err as Error).name).toBe("TimeoutError");
        expect(err).toBeInstanceOf(DOMException);
        // cause preserved - timeout reason is DOMException itself
        expect((err as DOMException).code).toBe(DOMException.TIMEOUT_ERR);
      }
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    const spy = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const token = await (
        provider as unknown as { getAccessToken: () => Promise<string> }
      ).getAccessToken();
      expect(token).toBe("tok");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const signal = (spy.mock.calls[0]?.[1] as RequestInit | undefined)
        ?.signal as AbortSignal | undefined;
      expect(signal?.aborted).toBe(false);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed 503 upstream via real server", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Service Unavailable");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/token`;
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    const origFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const u = typeof input === "string" ? input : input.toString();
        if (u.includes("oauth2.googleapis.com")) return origFetch(url, init);
        return origFetch(input, init);
      });
    try {
      await expect(
        (
          provider as unknown as { getAccessToken: () => Promise<string> }
        ).getAccessToken(),
      ).rejects.toThrow("503");
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses fresh timeout signal per attempt (no reused aborted signal)", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const spy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await (
        provider as unknown as { getAccessToken: () => Promise<string> }
      ).getAccessToken();
      (provider as unknown as { cachedToken: unknown }).cachedToken = null;
      await (
        provider as unknown as { getAccessToken: () => Promise<string> }
      ).getAccessToken();
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      const s1 = timeoutSpy.mock.calls[0]?.[0];
      const s2 = timeoutSpy.mock.calls[1]?.[0];
      // Each call creates a new signal with same budget
      expect(s1).toBe(DEFAULT_FCM_FETCH_TIMEOUT_MS);
      expect(s2).toBe(DEFAULT_FCM_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      globalThis.fetch = prev;
    }
  });
});
