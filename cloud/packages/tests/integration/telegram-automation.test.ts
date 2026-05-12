import { beforeAll, describe, expect, test } from "bun:test";
import { config } from "dotenv";

const preservedHarnessEnv = {
  CACHE_ENABLED: process.env.CACHE_ENABLED,
  DATABASE_URL: process.env.DATABASE_URL,
  DISABLE_LOCAL_PGLITE_FALLBACK: process.env.DISABLE_LOCAL_PGLITE_FALLBACK,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
  REDIS_URL: process.env.REDIS_URL,
  SECRETS_MASTER_KEY: process.env.SECRETS_MASTER_KEY,
  TEST_BASE_URL: process.env.TEST_BASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  TEST_SERVER_PORT: process.env.TEST_SERVER_PORT,
  TEST_SERVER_URL: process.env.TEST_SERVER_URL,
} as const;

// Load .env first, then .env.local to override (Next.js convention)
config({ path: ".env" });
config({ path: ".env.local", override: true });

for (const [key, value] of Object.entries(preservedHarnessEnv)) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

console.log("[Test Setup] Environment loaded");

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TEST_APP_ID = process.env.TEST_APP_ID || "test_app_id";

let apiKeyValid = false;

beforeAll(async () => {
  if (!API_KEY) {
    console.log("[Telegram Tests] No TEST_API_KEY set - auth tests will skip");
    return;
  }
  // Basic check if API key is somewhat valid
  const res = await fetch(`${SERVER_URL}/api/v1/users/me`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (res.status === 200) {
    apiKeyValid = true;
  }
});

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
  });
}

describe("Telegram Status API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/telegram/status`);
    expect(res.status).toBe(401);
  });

  test("returns status with valid auth", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth("/api/v1/telegram/status");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("configured");
    expect(data).toHaveProperty("connected");
  });
});

describe("Telegram Connect API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/telegram/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "123456:ABC" }),
    });
    expect(res.status).toBe(401);
  });

  test("validates bot token format", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth("/api/v1/telegram/connect", "POST", {
      botToken: "invalid",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toHaveProperty("error");
  });

  test("validates bot token must be at least 30 chars", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth("/api/v1/telegram/connect", "POST", {
      botToken: "123456:ABC",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.details?.fieldErrors?.botToken).toBeDefined();
  });
});

describe("Telegram Disconnect API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/telegram/disconnect`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  test("returns success with valid auth", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth("/api/v1/telegram/disconnect", "DELETE");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("success", true);
  });
});

describe("App Telegram Automation API", () => {
  test("GET returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${TEST_APP_ID}/telegram-automation`);
    expect(res.status).toBe(401);
  });

  test("GET returns 404 for non-existent app", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth(`/api/v1/apps/non-existent-app/telegram-automation`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toHaveProperty("error", "App not found");
  });

  test("POST returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${TEST_APP_ID}/telegram-automation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(401);
  });

  test("POST validates announceIntervalMin must be >= 30", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth(`/api/v1/apps/${TEST_APP_ID}/telegram-automation`, "POST", {
      announceIntervalMin: 10,
    });
    // Either 400 (validation) or 404 (app not found)
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.details?.fieldErrors?.announceIntervalMin).toBeDefined();
    }
  });

  test("POST validates announceIntervalMax must be <= 1440", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth(`/api/v1/apps/${TEST_APP_ID}/telegram-automation`, "POST", {
      announceIntervalMax: 2000,
    });
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.details?.fieldErrors?.announceIntervalMax).toBeDefined();
    }
  });

  test("DELETE returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${TEST_APP_ID}/telegram-automation`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});

describe("App Telegram Post API", () => {
  test("POST returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/apps/${TEST_APP_ID}/telegram-automation/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Test message" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST validates text must be <= 4000 chars", async () => {
    if (!apiKeyValid) return;
    const longText = "a".repeat(4001);
    const res = await fetchWithAuth(
      `/api/v1/apps/${TEST_APP_ID}/telegram-automation/post`,
      "POST",
      { text: longText },
    );
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.details?.fieldErrors?.text).toBeDefined();
    }
  });

  test("POST returns 404 for non-existent app", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth(
      `/api/v1/apps/non-existent-app/telegram-automation/post`,
      "POST",
      { text: "Test message" },
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data).toHaveProperty("error", "App not found");
  });
});

describe("Telegram Webhook API", () => {
  test("returns 404 or 401 for unknown organization", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/telegram/webhook/unknown-org-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 12345 }),
    });
    // Webhook may return auth failure, not found, or server error for unknown org
    expect([401, 404, 500]).toContain(res.status);
  });

  test("handles invalid JSON gracefully", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/telegram/webhook/test-org`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json",
    });
    // Returns 400 for invalid JSON, 401 if auth is required, or 500 when webhook isn't configured
    expect([400, 401, 500]).toContain(res.status);
  });
});

describe("Telegram API Input Validation", () => {
  test("connect rejects empty botToken", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth("/api/v1/telegram/connect", "POST", {
      botToken: "",
    });
    expect(res.status).toBe(400);
  });

  test("app automation validates welcomeMessage max length", async () => {
    if (!apiKeyValid) return;
    const longMessage = "a".repeat(501);
    const res = await fetchWithAuth(`/api/v1/apps/${TEST_APP_ID}/telegram-automation`, "POST", {
      welcomeMessage: longMessage,
    });
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.details?.fieldErrors?.welcomeMessage).toBeDefined();
    }
  });

  test("app automation validates vibeStyle max length", async () => {
    if (!apiKeyValid) return;
    const longStyle = "a".repeat(101);
    const res = await fetchWithAuth(`/api/v1/apps/${TEST_APP_ID}/telegram-automation`, "POST", {
      vibeStyle: longStyle,
    });
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.details?.fieldErrors?.vibeStyle).toBeDefined();
    }
  });

  test("app automation rejects min > max interval", async () => {
    if (!apiKeyValid) return;
    const res = await fetchWithAuth(`/api/v1/apps/${TEST_APP_ID}/telegram-automation`, "POST", {
      announceIntervalMin: 200,
      announceIntervalMax: 100,
    });
    expect([400, 404]).toContain(res.status);
    if (res.status === 400) {
      const data = await res.json();
      expect(data.error).toContain("announceIntervalMin must be less than");
    }
  });
});
