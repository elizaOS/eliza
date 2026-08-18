/** Verifies syntax and schema failures at the domain-search JSON request boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AvailabilityResult } from "@/lib/services/cloudflare-registrar";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const ORG_ID = "00000000-0000-4000-8000-0000000000bb";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
}));

const searchDomains = mock(
  async (_query: string, _limit: number): Promise<AvailabilityResult[]> => {
    throw new Error("cloudflareRegistrarService.searchDomains must not run");
  },
);
const computeDomainPrice = mock((cents: number) => cents);
const failureResponse = mock(
  (c: { json: (body: unknown, status: number) => unknown }) =>
    c.json({ success: false, error: "An unexpected error occurred" }, 500),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: { searchDomains },
}));

mock.module("@/lib/services/domain-pricing", () => ({
  computeDomainPrice,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

const { default: app } = await import("./route");

function post(raw: string) {
  return app.fetch(
    new Request("http://test.local/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: raw,
    }),
  );
}

describe("POST /api/v1/domains/search JSON body", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    searchDomains.mockClear();
    searchDomains.mockImplementation(async () => {
      throw new Error("cloudflareRegistrarService.searchDomains must not run");
    });
    failureResponse.mockClear();
    computeDomainPrice.mockClear();
  });

  test.each(["", "   ", "{", "not-json"])(
    "rejects malformed search body %j with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      expect((await res.json()) as { success: boolean; error: string }).toEqual(
        {
          success: false,
          error: "Invalid JSON body",
        },
      );
      expect(requireUserOrApiKeyWithOrg).toHaveBeenCalled();
      expect(searchDomains).not.toHaveBeenCalled();
      expect(failureResponse).not.toHaveBeenCalled();
    },
  );

  test.each(['["eliza"]', '"eliza"', "null", "12"])(
    "rejects non-object search body %s with 400",
    async (raw) => {
      const res = await post(raw);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).not.toBe("Invalid JSON body");
      expect(typeof body.error).toBe("string");
      expect(searchDomains).not.toHaveBeenCalled();
      expect(failureResponse).not.toHaveBeenCalled();
    },
  );

  test("still 400s a parseable object missing query via zod", async () => {
    const res = await post("{}");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(searchDomains).not.toHaveBeenCalled();
  });

  test("still searches a canonical object body", async () => {
    searchDomains.mockResolvedValue([
      {
        domain: "eliza.ai",
        available: true,
        currency: "USD",
        years: 1,
        priceUsdCents: 1200,
      },
    ]);

    const res = await post(JSON.stringify({ query: "eliza", limit: 3 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      query: "eliza",
      candidates: [{ domain: "eliza.ai", available: true, price: 1200 }],
    });
    expect(searchDomains).toHaveBeenCalledTimes(1);
    expect(searchDomains.mock.calls[0]?.[0]).toBe("eliza");
    expect(searchDomains.mock.calls[0]?.[1]).toBe(3);
  });
});
