/**
 * Unit tests for shared hardware checkout client and error formatting.
 * Validates Stripe checkout session payload creation, token headers, and error handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStripeCheckoutSession,
  StripeCheckoutError,
  startStripeCheckout,
} from "../index.ts";

describe("checkout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("StripeCheckoutError", () => {
    it("sets error properties and custom name correctly", () => {
      const err = new StripeCheckoutError("Payment failed", 402);
      expect(err.message).toBe("Payment failed");
      expect(err.status).toBe(402);
      expect(err.name).toBe("StripeCheckoutError");
    });
  });

  describe("createStripeCheckoutSession", () => {
    it("sends request with headers and bearer token and returns session url on success", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_12345",
        }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      const url = await createStripeCheckoutSession(
        {
          hardwareSku: "eliza-hw-1",
          hardwareColor: "black",
          returnUrl: "https://eliza.app/checkout/complete",
        },
        {
          apiBaseUrl: "https://api.eliza.app",
          bearerToken: "steward-session-token",
        },
      );

      expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test_12345");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.eliza.app/api/stripe/create-checkout-session",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer steward-session-token",
          },
        }),
      );
    });

    it("throws StripeCheckoutError on non-OK response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "Invalid hardware SKU" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        createStripeCheckoutSession(
          {
            hardwareSku: "invalid-sku",
            hardwareColor: "black",
            returnUrl: "https://eliza.app/checkout/complete",
          },
          {
            apiBaseUrl: "",
          },
        ),
      ).rejects.toThrow("Invalid hardware SKU");
    });

    it("throws StripeCheckoutError when response body is missing url", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      await expect(
        createStripeCheckoutSession(
          {
            hardwareSku: "eliza-hw-1",
            hardwareColor: "black",
            returnUrl: "https://eliza.app/checkout/complete",
          },
          {
            apiBaseUrl: "https://api.eliza.app",
          },
        ),
      ).rejects.toThrow("Could not start checkout.");
    });
  });

  describe("startStripeCheckout", () => {
    it("redirects window.location to checkout url", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: "https://checkout.stripe.com/pay/cs_999" }),
      });
      globalThis.fetch = mockFetch as unknown as typeof fetch;
      const originalWindow = globalThis.window;
      const mockLocation = { href: "" };
      globalThis.window = { location: mockLocation } as unknown as Window &
        typeof globalThis;

      try {
        await startStripeCheckout(
          {
            hardwareSku: "eliza-hw-1",
            hardwareColor: "black",
            returnUrl: "https://eliza.app/checkout/complete",
          },
          {
            apiBaseUrl: "https://api.eliza.app",
          },
        );
        expect(mockLocation.href).toBe(
          "https://checkout.stripe.com/pay/cs_999",
        );
      } finally {
        globalThis.window = originalWindow;
      }
    });
  });
});
