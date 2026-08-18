/**
 * Checkout fetch deadline — proves the shared Stripe checkout client aborts
 * hanging and body-stalled requests at the documented 10s budget and merges
 * a caller signal via AbortSignal.any.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStripeCheckoutSession,
  DEFAULT_STRIPE_CHECKOUT_FETCH_TIMEOUT_MS,
} from "./index.ts";

const request = {
  hardwareSku: "sku-1",
  hardwareColor: "black",
  returnUrl: "https://example.com/return",
};

describe("createStripeCheckoutSession fetch timeout", () => {
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    origTimeout = AbortSignal.timeout.bind(AbortSignal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_STRIPE_CHECKOUT_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled checkout POST at the deadline", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.example.com",
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("/api/stripe/create-checkout-session"),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          method: "POST",
        }),
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("keeps the deadline active while the response body stalls", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => origTimeout(10));
    const spy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      if (!sig) throw new Error("signal missing body stall");
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            sig.addEventListener("abort", () => reject(sig.reason), {
              once: true,
            });
          }),
      } as unknown as Response;
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.example.com",
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("merges a caller signal via AbortSignal.any", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      origTimeout(10_000),
    );
    const anySpy = vi.spyOn(AbortSignal, "any");
    const controller = new AbortController();
    const spy = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      // trigger caller abort immediately
      queueMicrotask(() =>
        controller.abort(new DOMException("caller abort", "AbortError")),
      );
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing any");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.example.com",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(anySpy).toHaveBeenCalled();
      const sig = (spy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal as
        | AbortSignal
        | undefined;
      expect(sig).toBeDefined();
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("passes through a successful checkout response", async () => {
    const spy = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: "https://checkout.stripe.com/c/pay_123" }),
      } as unknown as Response;
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const url = await createStripeCheckoutSession(request, {
        apiBaseUrl: "https://api.example.com",
        timeoutMs: 5000,
      });
      expect(url).toBe("https://checkout.stripe.com/c/pay_123");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
