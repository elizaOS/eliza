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

import { describe, test, expect, beforeAll } from "bun:test";

const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TIMEOUT = 30000; // 30 seconds for AI generation

let apiKeyValid = false;

async function fetchWithAuth(
  endpoint: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  return fetch(`${SERVER_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

// Validate API key before running tests
beforeAll(async () => {
  if (!API_KEY) {
    console.log(
      "[Promotion Preview Tests] No TEST_API_KEY set - auth tests will skip",
    );
    return;
  }

  // Try a simple authenticated request to validate the key
  const res = await fetchWithAuth("/api/v1/apps");
  apiKeyValid = res.status !== 401;

  if (!apiKeyValid) {
    console.log(
      "[Promotion Preview Tests] TEST_API_KEY is invalid - auth tests will skip",
    );
  } else {
    console.log("[Promotion Preview Tests] TEST_API_KEY is valid");
  }
});

describe("Promotion Preview API", () => {
  const FAKE_APP_ID = "00000000-0000-0000-0000-000000000000";

  test("returns 401 without auth", async () => {
    const res = await fetch(
      `${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: ["discord"], count: 1 }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("returns 400 for invalid request - missing platforms", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

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
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { platforms: [], count: 1 },
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for invalid request - invalid platform name", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { platforms: ["invalid_platform"], count: 1 },
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for invalid request - count too high", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

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
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { platforms: ["discord"], count: 1 },
    );
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty("error");
    expect(data.error).toBe("App not found");
  });

  test("accepts valid platform names", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    // Test that valid platform names are accepted (will fail at 404 for fake app)
    const validPlatforms = ["discord", "telegram", "twitter"];

    for (const platform of validPlatforms) {
      const res = await fetchWithAuth(
        `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
        "POST",
        { platforms: [platform], count: 1 },
      );
      // Should fail with 404 (app not found), not 400 (invalid request)
      expect(res.status).toBe(404);
    }
  });

  test("accepts multiple platforms in request", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/promote/preview`,
      "POST",
      { platforms: ["discord", "telegram", "twitter"], count: 2 },
    );
    // Should fail with 404 (app not found), not 400 (invalid request)
    expect(res.status).toBe(404);
  });
});
