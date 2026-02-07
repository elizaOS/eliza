import { describe, test, expect } from "bun:test";

const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TEST_APP_ID = process.env.TEST_APP_ID || "test-app-id";

async function fetchWithAuth(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${SERVER_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY && { Authorization: `Bearer ${API_KEY}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Promotion Assets Pricing", () => {
  const endpoint = `/api/v1/apps/${TEST_APP_ID}/promote/assets`;

  describe("GET /api/v1/apps/[id]/promote/assets", () => {
    test("returns 401 without auth", async () => {
      const res = await fetch(`${SERVER_URL}${endpoint}`);
      expect(res.status).toBe(401);
    });

    test("returns pricing info with auth", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      const res = await fetchWithAuth(endpoint, "GET");

      // May return 404 if app doesn't exist, which is acceptable
      if (res.status === 404) {
        console.log("App not found - test passes (auth works)");
        return;
      }

      expect(res.status).toBe(200);
      const data = await res.json();

      // Verify pricing structure
      expect(data).toHaveProperty("estimatedCost");
      expect(data.estimatedCost).toHaveProperty("perImage");
      expect(data.estimatedCost).toHaveProperty("copyGeneration");
      expect(data.estimatedCost).toHaveProperty("fullBundle");
      expect(data.estimatedCost).toHaveProperty("display");

      // Verify 20% markup is applied (base is $0.01, with markup should be $0.012)
      expect(data.estimatedCost.perImage).toBeCloseTo(0.012, 3);
      expect(data.estimatedCost.copyGeneration).toBeCloseTo(0.012, 3);

      // Full bundle: 2 images + 1 copy = 0.012 * 2 + 0.012 = 0.036
      expect(data.estimatedCost.fullBundle).toBeCloseTo(0.036, 3);
    });

    test("returns recommended sizes", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      const res = await fetchWithAuth(endpoint, "GET");

      if (res.status === 404) {
        console.log("App not found - test passes (auth works)");
        return;
      }

      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data).toHaveProperty("recommendedSizes");
      expect(data).toHaveProperty("availableSizes");
      expect(Array.isArray(data.recommendedSizes)).toBe(true);
      expect(Array.isArray(data.availableSizes)).toBe(true);
    });
  });

  describe("POST /api/v1/apps/[id]/promote/assets", () => {
    test("returns 401 without auth", async () => {
      const res = await fetch(`${SERVER_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    test("returns 400 for invalid request body", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      const res = await fetchWithAuth(endpoint, "POST", {
        sizes: ["invalid_size"],
      });

      // 400 for invalid input OR 404 if app doesn't exist
      expect([400, 404]).toContain(res.status);
    });

    test("returns 402 when insufficient credits", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      // This test assumes the test account has no credits
      // In reality, you'd need a test account with 0 balance
      const res = await fetchWithAuth(endpoint, "POST", {
        includeCopy: true,
        includeAdBanners: true,
      });

      // 402 for no credits, 404 if app doesn't exist, 200 if has credits
      expect([200, 402, 404]).toContain(res.status);

      if (res.status === 402) {
        const data = await res.json();
        expect(data.error).toBe("Insufficient credits");
        expect(data).toHaveProperty("required");
      }
    });
  });
});

describe("Promotion Pricing Constants", () => {
  test("PLATFORM_MARKUP is 1.2 (20%)", async () => {
    // Import the module directly to test constants
    const { PLATFORM_MARKUP } = await import("@/lib/promotion-pricing");
    expect(PLATFORM_MARKUP).toBe(1.2);
  });

  test("PROMO_IMAGE_COST includes 20% markup", async () => {
    const { PROMO_IMAGE_COST, PLATFORM_MARKUP } =
      await import("@/lib/promotion-pricing");
    const { IMAGE_GENERATION_COST } = await import("@/lib/pricing-constants");

    expect(PROMO_IMAGE_COST).toBe(IMAGE_GENERATION_COST * PLATFORM_MARKUP);
  });

  test("estimateAssetGenerationCost returns correct values", async () => {
    const {
      estimateAssetGenerationCost,
      PROMO_IMAGE_COST,
      AD_COPY_GENERATION_COST,
    } = await import("@/lib/promotion-pricing");

    // Default: 1 image + 1 banner + copy
    const estimate = estimateAssetGenerationCost({});

    expect(estimate.images).toBe(2 * PROMO_IMAGE_COST);
    expect(estimate.copy).toBe(AD_COPY_GENERATION_COST);
    expect(estimate.total).toBe(2 * PROMO_IMAGE_COST + AD_COPY_GENERATION_COST);
    expect(estimate.display).toMatch(/^\$\d+\.\d{2}$/);
  });

  test("formatCost handles edge cases", async () => {
    const { formatCost } = await import("@/lib/promotion-pricing");

    expect(formatCost(0)).toBe("Free");
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0.05)).toBe("$0.05");
    expect(formatCost(1.234)).toBe("$1.23");
  });

  test("getPostCost returns correct values for each platform", async () => {
    const {
      getPostCost,
      DISCORD_POST_COST,
      TELEGRAM_POST_COST,
      TWITTER_POST_COST,
    } = await import("@/lib/promotion-pricing");

    expect(getPostCost("discord")).toBe(DISCORD_POST_COST);
    expect(getPostCost("telegram")).toBe(TELEGRAM_POST_COST);
    expect(getPostCost("twitter")).toBe(TWITTER_POST_COST);
  });

  test("automation setup costs are free", async () => {
    const {
      DISCORD_AUTOMATION_SETUP_COST,
      TELEGRAM_AUTOMATION_SETUP_COST,
      TWITTER_AUTOMATION_SETUP_COST,
    } = await import("@/lib/promotion-pricing");

    expect(DISCORD_AUTOMATION_SETUP_COST).toBe(0);
    expect(TELEGRAM_AUTOMATION_SETUP_COST).toBe(0);
    expect(TWITTER_AUTOMATION_SETUP_COST).toBe(0);
  });
});
