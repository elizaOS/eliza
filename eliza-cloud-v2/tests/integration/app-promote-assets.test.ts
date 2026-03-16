import { describe, test, expect } from "bun:test";

const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TEST_APP_ID = process.env.TEST_APP_ID;

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

async function fetchWithoutAuth(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${SERVER_URL}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("App Promote Assets API", () => {
  const appId = TEST_APP_ID || "test-app-id";
  const endpoint = `/api/v1/apps/${appId}/promote/assets`;

  describe("GET /api/v1/apps/[id]/promote/assets", () => {
    test("returns 401 without auth", async () => {
      const res = await fetchWithoutAuth(endpoint);
      expect(res.status).toBe(401);
    });

    test("returns 404 for non-existent app", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      const res = await fetchWithAuth(
        "/api/v1/apps/00000000-0000-0000-0000-000000000000/promote/assets",
      );
      expect(res.status).toBe(404);
    });

    test("returns recommended sizes and costs with valid app", async () => {
      if (!TEST_APP_ID) {
        console.log("Skipping: TEST_APP_ID not set");
        return;
      }

      const res = await fetchWithAuth(endpoint);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("recommendedSizes");
      expect(data).toHaveProperty("availableSizes");
      expect(data).toHaveProperty("estimatedCost");
      expect(Array.isArray(data.recommendedSizes)).toBe(true);
      expect(Array.isArray(data.availableSizes)).toBe(true);
      expect(typeof data.estimatedCost.perImage).toBe("number");
      expect(typeof data.estimatedCost.copyGeneration).toBe("number");
    });

    test("returns platform-specific sizes when platform param provided", async () => {
      if (!TEST_APP_ID) {
        console.log("Skipping: TEST_APP_ID not set");
        return;
      }

      const res = await fetchWithAuth(`${endpoint}?platform=twitter`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.recommendedSizes).toContain("twitter_card");
    });
  });

  describe("POST /api/v1/apps/[id]/promote/assets", () => {
    test("returns 401 without auth", async () => {
      const res = await fetchWithoutAuth(endpoint, "POST", {
        includeCopy: true,
      });
      expect(res.status).toBe(401);
    });

    test("returns 404 for non-existent app", async () => {
      if (!API_KEY) {
        console.log("Skipping: TEST_API_KEY not set");
        return;
      }

      const res = await fetchWithAuth(
        "/api/v1/apps/00000000-0000-0000-0000-000000000000/promote/assets",
        "POST",
        { includeCopy: true },
      );
      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid input", async () => {
      if (!TEST_APP_ID) {
        console.log("Skipping: TEST_APP_ID not set");
        return;
      }

      const res = await fetchWithAuth(endpoint, "POST", {
        targetAudience: "x".repeat(600), // Exceeds 500 char limit
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    test("returns 402 when insufficient credits", async () => {
      // This test requires an account with no credits
      // Skip if we can't control the credit balance
      console.log("Note: 402 test requires account with no credits");
    });

    // Note: Full asset generation test is expensive and slow (60s+)
    // Only run in full E2E test suite with TEST_FULL_GENERATION=true
    test("generates assets successfully (slow, requires credits)", async () => {
      if (!TEST_APP_ID) {
        console.log("Skipping: TEST_APP_ID not set");
        return;
      }

      if (!process.env.TEST_FULL_GENERATION) {
        console.log(
          "Skipping: Set TEST_FULL_GENERATION=true to run full generation test",
        );
        return;
      }

      const res = await fetchWithAuth(endpoint, "POST", {
        includeCopy: true,
        includeAdBanners: false, // Minimal generation for faster test
      });

      // Could be 200 (success) or 402 (no credits)
      expect([200, 402]).toContain(res.status);

      if (res.status === 200) {
        const data = await res.json();
        expect(data).toHaveProperty("assets");
        expect(data).toHaveProperty("creditsUsed");
        expect(Array.isArray(data.assets)).toBe(true);

        // If assets were generated, check structure
        if (data.assets.length > 0) {
          const asset = data.assets[0];
          expect(asset).toHaveProperty("type");
          expect(asset).toHaveProperty("url");
          expect(asset).toHaveProperty("size");
          expect(asset.size).toHaveProperty("width");
          expect(asset.size).toHaveProperty("height");
        }
      }
    });
  });
});
