/**
 * Unit tests for shared hardware stripe checkout session creation and error handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStripeCheckoutSession, StripeCheckoutError } from "../index.ts";

describe("checkout", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
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

    it.each([
      null,
      [],
      {},
      { url: 42 },
      { url: { href: "https://checkout.stripe.com" } },
      { url: "" },
    ])(
      "rejects malformed successful response %j before returning a redirect",
      async (body) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json(body)),
        );
        await expect(
          createStripeCheckoutSession(
            {
              hardwareSku: "SKU-PRO-1",
              hardwareColor: "black",
              returnUrl: "https://elizaos.ai/order/success",
            },
            { apiBaseUrl: "https://api.eliza.app" },
          ),
        ).rejects.toBeInstanceOf(StripeCheckoutError);
      },
    );

    it("rejects an unreadable JSON response as a checkout failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not JSON", { status: 200 })),
      );
      await expect(
        createStripeCheckoutSession(
          {
            hardwareSku: "SKU-PRO-1",
            hardwareColor: "black",
            returnUrl: "https://elizaos.ai/order/success",
          },
          { apiBaseUrl: "https://api.eliza.app" },
        ),
      ).rejects.toBeInstanceOf(StripeCheckoutError);
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
