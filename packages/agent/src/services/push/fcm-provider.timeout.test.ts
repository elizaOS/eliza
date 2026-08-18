/**
 * FcmProvider fetch deadlines — proves the production provider aborts on
 * timeout via mocked hanging fetch, covering both token and send paths.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FCM_FETCH_TIMEOUT_MS, FcmProvider } from "./fcm-provider";

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

describe("FcmProvider fetch timeout", () => {
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

  it("aborts a stalled OAuth token exchange at the deadline", async () => {
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

  it("aborts a stalled FCM send at the deadline", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    // Pre-cache token to avoid token fetch
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
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const { privatePem } = makeRsaKey();
    const provider = new FcmProvider(envWith(privatePem));
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        (
          provider as unknown as { getAccessToken: () => Promise<string> }
        ).getAccessToken(),
      ).rejects.toThrow("503");
    } finally {
      globalThis.fetch = prev;
    }
  });
});
