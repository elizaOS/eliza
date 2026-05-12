/**
 * Promotion Preview API Integration Tests
 *
 * Tests the promotion preview endpoint:
 * - POST /api/v1/apps/[id]/promote/preview
 *
 * Requirements:
 * - TEST_API_KEY: Valid API key with credits
 * - Server running at TEST_SERVER_URL (default: http://localhost:3000)
 */

import { beforeAll, describe, expect, test } from "bun:test";

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const TIMEOUT = 30000; // 30 seconds for AI generation

function requireTestApiKey(): string {
  const apiKey = process.env.TEST_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TEST_API_KEY must be set for promotion preview integration tests");
  }
  return apiKey;
}

async function fetchWithAuth(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${requireTestApiKey()}`,
  };

  return fetch(`${SERVER_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

beforeAll(async () => {
  const res = await fetchWithAuth("/api/v1/apps");
  if (res.status === 401) {
    throw new Error("TEST_API_KEY was rejected by /api/v1/apps");
  }
});

describe("Promotion Preview API", () => {
  const FAKE_APP_ID = "00000000-0000-0000-0000-000000000000";

  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/promote/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms: ["discord"], count: 1 }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for invalid request - missing platforms", async () => {
    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { count: 1 }, // Missing required 'platforms' field
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toBe("Invalid request");
  });

  test("returns 400 for invalid request - empty platforms array", async () => {
    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/promote/preview`, "POST", {
      platforms: [],
      count: 1,
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for invalid request - invalid platform name", async () => {
    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/promote/preview`, "POST", {
      platforms: ["invalid_platform"],
      count: 1,
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for invalid request - count too high", async () => {
    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { platforms: ["discord"], count: 10 }, // Max is 4
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 404 for non-existent app", async () => {
    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/promote/preview`, "POST", {
      platforms: ["discord"],
      count: 1,
    });
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toBe("App not found");
  });

  test("accepts valid platform names", async () => {
    const validPlatforms = ["discord", "telegram", "twitter"];

    for (const platform of validPlatforms) {
      const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/promote/preview`, "POST", {
        platforms: [platform],
        count: 1,
      });
      // Should fail with 404 (app not found), not 400 (invalid request)
      expect(res.status).toBe(404);
    }
  });

  test("accepts multiple platforms in request", async () => {
    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/promote/preview`, "POST", {
      platforms: ["discord", "telegram", "twitter"],
      count: 2,
    });
    // Should fail with 404 (app not found), not 400 (invalid request)
    expect(res.status).toBe(404);
  });
});
