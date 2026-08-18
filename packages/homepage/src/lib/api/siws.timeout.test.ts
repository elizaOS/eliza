/**
 * SIWS fetch deadlines — proves the production helper aborts on timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SIWS_FETCH_TIMEOUT_MS, signInWithSolana } from "./siws";

describe("SIWS fetch timeout", () => {
  const originalFetch = globalThis.fetch;
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
    (globalThis as unknown as { window: unknown }).window =
      globalThis as unknown as Window;
    (
      globalThis as unknown as { window: { __siwsTestSigner: unknown } }
    ).window.__siwsTestSigner = {
      publicKey: "11111111111111111111111111111111",
      sign: (msg: Uint8Array) => msg,
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete (globalThis as unknown as { window: unknown }).window;
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_SIWS_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled SIWS nonce fetch at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing siws nonce");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(signInWithSolana()).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("/api/auth/siws/nonce"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("aborts a stalled SIWS verify body at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (!init?.signal) throw new Error("signal missing nonce success");
        return new Response(
          JSON.stringify({
            nonce: "test-nonce",
            domain: "example.com",
            uri: "https://example.com",
            chainId: "solana:mainnet",
            version: "1",
            statement: "Sign in",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (!sig) throw new Error("signal missing siws verify");
          sig.addEventListener("abort", () => reject(sig.reason), {
            once: true,
          });
        });
      });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(signInWithSolana()).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("/api/auth/siws/verify"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const spy = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (!init?.signal) throw new Error("signal missing nonce fast");
        return new Response(
          JSON.stringify({
            nonce: "test-nonce",
            domain: "example.com",
            uri: "https://example.com",
            chainId: "solana:mainnet",
            version: "1",
            statement: "Sign in",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      })
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        if (!init?.signal) throw new Error("signal missing verify fast");
        return new Response(
          JSON.stringify({
            apiKey: "test-key",
            address: "11111111111111111111111111111111",
            isNewAccount: false,
            user: {
              id: "u1",
              wallet_address: "11111111111111111111111111111111",
              organization_id: "o1",
            },
            organization: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await signInWithSolana();
      expect(result.apiKey).toBe("test-key");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const sig = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      expect(sig?.aborted).toBe(false);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const spy = vi.fn(
      async () => new Response("Service Unavailable", { status: 503 }),
    );
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(signInWithSolana()).rejects.toThrow(
        "SIWS nonce request failed: 503",
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});
