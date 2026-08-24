/**
 * Unit tests for shared hardware stripe checkout session creation and error handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeCheckoutSession, StripeCheckoutError } from "../index.ts";

describe("checkout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createStripeCheckoutSession", () => {
    it("successfully creates checkout session and returns redirect URL", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const url = await createStripeCheckoutSession(
        {
          hardwareSku: "SKU-PRO-1",
          hardwareColor: "black",
          returnUrl: "https://elizaos.ai/order/success",
        },
        {
          apiBaseUrl: "https://api.eliza.app",
          bearerToken: "steward-session-token",
        },
      );

      expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.eliza.app/api/stripe/create-checkout-session",
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer steward-session-token",
          },
          body: JSON.stringify({
            hardwareSku: "SKU-PRO-1",
            hardwareColor: "black",
            returnUrl: "https://elizaos.ai/order/success",
          }),
        },
      );
    });

    it("throws StripeCheckoutError on non-200 response with server error message", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "SKU out of stock" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        createStripeCheckoutSession(
          {
            hardwareSku: "SKU-OUT",
            hardwareColor: "white",
            returnUrl: "https://elizaos.ai/order/success",
          },
          {
            apiBaseUrl: "https://api.eliza.app",
          },
        ),
      ).rejects.toThrow(StripeCheckoutError);
    });

    it("throws StripeCheckoutError with default message when response body is not JSON or missing url", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        createStripeCheckoutSession(
          {
            hardwareSku: "SKU-PRO-1",
            hardwareColor: "black",
            returnUrl: "https://elizaos.ai/order/success",
          },
          {
            apiBaseUrl: "",
          },
        ),
      ).rejects.toThrow("Could not start checkout.");
    });
  });
});

describe("checkout error contract and navigation wrapper", () => {
  const originalFetch = globalThis.fetch;
  const windowSlot = globalThis as { window?: unknown };
  const originalWindow = windowSlot.window;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    windowSlot.window = originalWindow;
    vi.restoreAllMocks();
  });

  const request = {
    hardwareSku: "SKU-PRO-1",
    hardwareColor: "black",
    returnUrl: "https://elizaos.ai/order/success",
  };

  async function rejectionOf(promise: Promise<string>): Promise<unknown> {
    return promise.catch((reason: unknown) => reason);
  }

  describe("createStripeCheckoutSession", () => {
    it("omits the Authorization header when bearerToken is null", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_anon",
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const url = await createStripeCheckoutSession(request, {
        apiBaseUrl: "https://api.eliza.app",
        bearerToken: null,
      });

      expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_anon");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(init.headers).toEqual({ "Content-Type": "application/json" });
    });

    it("sends the caller-supplied credentials mode instead of the default include", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_sameorigin",
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await createStripeCheckoutSession(request, {
        apiBaseUrl: "https://api.eliza.app",
        credentials: "same-origin",
      });

      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(init.credentials).toBe("same-origin");
    });

    it("carries the server error message and HTTP status on StripeCheckoutError", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        json: async () => ({ error: "Card declined" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const error = await rejectionOf(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.eliza.app",
        }),
      );

      expect(error).toBeInstanceOf(StripeCheckoutError);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof StripeCheckoutError)) {
        throw new Error("expected a StripeCheckoutError rejection");
      }
      expect(error.name).toBe("StripeCheckoutError");
      expect(error.message).toBe("Card declined");
      expect(error.status).toBe(402);
    });

    it("falls back to the default message and keeps the status when the body is not JSON", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const error = await rejectionOf(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.eliza.app",
        }),
      );

      expect(error).toBeInstanceOf(StripeCheckoutError);
      if (!(error instanceof StripeCheckoutError)) {
        throw new Error("expected a StripeCheckoutError rejection");
      }
      expect(error.message).toBe("Could not start checkout.");
      expect(error.status).toBe(503);
    });

    it("surfaces the server error when a 200 response carries no url", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ error: "Session expired" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const error = await rejectionOf(
        createStripeCheckoutSession(request, {
          apiBaseUrl: "https://api.eliza.app",
        }),
      );

      expect(error).toBeInstanceOf(StripeCheckoutError);
      if (!(error instanceof StripeCheckoutError)) {
        throw new Error("expected a StripeCheckoutError rejection");
      }
      expect(error.message).toBe("Session expired");
      expect(error.status).toBe(200);
    });
  });

  describe("startStripeCheckout", () => {
    it("navigates the browser to the returned Stripe URL", async () => {
      const { startStripeCheckout } = await import("../index.ts");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_nav",
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      const location = { href: "" };
      windowSlot.window = { location };

      await startStripeCheckout(request, {
        apiBaseUrl: "https://api.eliza.app",
        bearerToken: "steward-session-token",
      });

      expect(location.href).toBe(
        "https://checkout.stripe.com/c/pay/cs_test_nav",
      );
    });

    it("propagates session failures without navigating", async () => {
      const { startStripeCheckout } = await import("../index.ts");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      const location = { href: "" };
      windowSlot.window = { location };

      await expect(
        startStripeCheckout(request, { apiBaseUrl: "https://api.eliza.app" }),
      ).rejects.toThrow(StripeCheckoutError);
      expect(location.href).toBe("");
    });
  });
});
