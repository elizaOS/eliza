import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dbWrite } from "@/db/client";
import { apps } from "@/db/schemas/apps";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/infrastructure/test-data-factory";

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

let testData: TestDataSet | null = null;
let appId: string;
let endpoint: string;
let apiKey: string;

beforeAll(async () => {
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set for app promotion tests");
  }

  testData = await createTestDataSet(databaseUrl, {
    organizationName: "App Promotion Assets Test Org",
    creditBalance: 0,
  });

  appId = crypto.randomUUID();
  endpoint = `/api/v1/apps/${appId}/promote/assets`;
  apiKey = testData.apiKey.key;

  await dbWrite.insert(apps).values({
    id: appId,
    name: "Promotion Assets Test App",
    slug: `promotion-assets-test-${crypto.randomUUID().slice(0, 8)}`,
    organization_id: testData.organization.id,
    created_by_user_id: testData.user.id,
    app_url: "https://promotion-assets.test/app",
    allowed_origins: ["https://promotion-assets.test"],
  });
});

afterAll(async () => {
  if (databaseUrl && testData) {
    await cleanupTestData(databaseUrl, testData.organization.id);
  }
});

async function fetchWithAuth(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${SERVER_URL}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
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
  describe("GET /api/v1/apps/[id]/promote/assets", () => {
    test("returns 401 without auth", async () => {
      const res = await fetchWithoutAuth(endpoint);
      expect(res.status).toBe(401);
    });

    test("returns 404 for non-existent app", async () => {
      const res = await fetchWithAuth(
        "/api/v1/apps/00000000-0000-0000-0000-000000000000/promote/assets",
      );
      expect(res.status).toBe(404);
    });

    test("returns recommended sizes and costs with valid app", async () => {
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
      const res = await fetchWithAuth(
        "/api/v1/apps/00000000-0000-0000-0000-000000000000/promote/assets",
        "POST",
        { includeCopy: true },
      );
      expect(res.status).toBe(404);
    });

    test("returns 400 for invalid input", async () => {
      const res = await fetchWithAuth(endpoint, "POST", {
        targetAudience: "x".repeat(600), // Exceeds 500 char limit
      });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    test("returns 402 when insufficient credits", async () => {
      const res = await fetchWithAuth(endpoint, "POST", {
        includeCopy: true,
        includeAdBanners: false,
      });

      expect(res.status).toBe(402);
      const data = await res.json();
      expect(data).toHaveProperty("error", "Insufficient credits");
      expect(typeof data.required).toBe("number");
    });
  });
});
