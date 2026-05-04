/**
 * Twitter Automation API Integration Tests
 *
 * Tests the Twitter automation endpoints:
 * - GET /api/v1/twitter/status
 * - POST /api/v1/twitter/connect
 * - DELETE /api/v1/twitter/disconnect
 * - GET/POST/DELETE /api/v1/apps/[id]/twitter-automation
 * - POST /api/v1/apps/[id]/twitter-automation/post
 *
 * Requirements:
 * - TEST_API_KEY: Valid API key with credits
 * - Server running at TEST_SERVER_URL (default: http://localhost:3000)
 */

import { beforeAll, describe, expect, test } from "bun:test";

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TIMEOUT = 15000;

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

// Validate API key before running auth tests
beforeAll(async () => {
  if (!API_KEY) {
    console.log("[Twitter Tests] No TEST_API_KEY set - auth tests will skip");
    return;
  }

  // Try a simple authenticated request to validate the key
  const res = await fetchWithAuth("/api/v1/twitter/status");
  apiKeyValid = res.status !== 401;

  if (!apiKeyValid) {
    console.log("[Twitter Tests] TEST_API_KEY is invalid - auth tests will skip");
  } else {
    console.log("[Twitter Tests] TEST_API_KEY is valid");
  }
});

describe("Twitter Status API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/twitter/status`);
    expect(res.status).toBe(401);
  });

  test("returns status with valid auth", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth("/api/v1/twitter/status");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("configured");
    expect(typeof data.configured).toBe("boolean");

    if (data.configured) {
      expect(data).toHaveProperty("connected");
      expect(typeof data.connected).toBe("boolean");
    }
  });
});

describe("Twitter Connect API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/twitter/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("returns auth URL or 503 if not configured", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth("/api/v1/twitter/connect", "POST", {
      redirectUrl: "/dashboard/settings",
    });

    // Either 200 (configured) or 503 (not configured)
    expect([200, 503]).toContain(res.status);

    const data = await res.json();
    if (res.status === 200) {
      expect(data).toHaveProperty("authUrl");
      expect(data).toHaveProperty("oauthToken");
      expect(typeof data.authUrl).toBe("string");
    } else {
      expect(data).toHaveProperty("error");
    }
  });
});

describe("Twitter Disconnect API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/twitter/disconnect`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("returns success with valid auth", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth("/api/v1/twitter/disconnect", "DELETE");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success");
    expect(data.success).toBe(true);
  });
});

describe("App Twitter Automation API", () => {
  const FAKE_APP_ID = "00000000-0000-0000-0000-000000000000";

  test("GET returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/twitter-automation`);
    expect(res.status).toBe(401);
  });

  test("GET returns error for non-existent app", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/twitter-automation`);
    // App not found may be surfaced directly or through the route error handler.
    expect([404, 500]).toContain(res.status);
  });

  test("POST returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/twitter-automation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(401);
  });

  test("POST validates postIntervalMin must be >= 30", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/twitter-automation`,
      "POST",
      { postIntervalMin: 10 }, // Invalid: below minimum of 30
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("POST validates postIntervalMax must be <= 1440", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(
      `/api/v1/apps/${FAKE_APP_ID}/twitter-automation`,
      "POST",
      { postIntervalMax: 2000 }, // Invalid: above maximum of 1440
    );
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("DELETE returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/twitter-automation`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});

describe("App Twitter Post API", () => {
  const FAKE_APP_ID = "00000000-0000-0000-0000-000000000000";

  test("POST returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${FAKE_APP_ID}/twitter-automation/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test("POST validates text must be <= 280 chars", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const longText = "a".repeat(281);
    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/twitter-automation/post`, "POST", {
      text: longText,
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("POST returns error for non-existent app", async () => {
    if (!apiKeyValid) {
      console.log("Skipping: No valid API key");
      return;
    }

    const res = await fetchWithAuth(`/api/v1/apps/${FAKE_APP_ID}/twitter-automation/post`, "POST", {
      text: "Test tweet",
    });
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty("error");
  });
});
