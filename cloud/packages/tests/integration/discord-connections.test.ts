/**
 * Discord Connections API Integration Tests
 *
 * Tests for the Discord connections API endpoints.
 *
 * Prerequisites:
 * - Set TEST_SERVER_URL (default: http://localhost:3000)
 * - Set TEST_API_KEY (Bearer token for authentication)
 * - Set TEST_CHARACTER_ID (valid character UUID in your organization)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

// Load environment variables
config({ path: ".env" });
config({ path: ".env.local", override: true });

for (const [key, value] of Object.entries(preservedHarnessEnv)) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.TEST_API_KEY;
const TEST_CHARACTER_ID = process.env.TEST_CHARACTER_ID;

// Track created connections for cleanup
const createdConnectionIds: string[] = [];

let apiKeyValid = false;
let hasTestCharacter = false;

beforeAll(async () => {
  if (!API_KEY) {
    console.log("[Discord Connections Tests] No TEST_API_KEY set - auth tests will skip");
    return;
  }

  // Verify API key is valid
  const res = await fetch(`${SERVER_URL}/api/v1/user`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (res.status === 200) {
    apiKeyValid = true;
  }

  // Check if we have a test character
  if (TEST_CHARACTER_ID) {
    hasTestCharacter = true;
  } else {
    console.log("[Discord Connections Tests] No TEST_CHARACTER_ID set - creation tests will skip");
  }
});

afterAll(async () => {
  // Clean up created connections
  if (apiKeyValid && createdConnectionIds.length > 0) {
    console.log(
      `[Discord Connections Tests] Cleaning up ${createdConnectionIds.length} test connections`,
    );
    for (const id of createdConnectionIds) {
      try {
        await fetch(`${SERVER_URL}/api/v1/discord/connections/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${API_KEY}` },
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

async function fetchWithAuth(
  endpoint: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
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

describe("Discord Connections List API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/discord/connections`);
    expect(res.status).toBe(401);
  });

  test("returns connections list with valid auth", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("connections");
    expect(Array.isArray(data.connections)).toBe(true);
  });

  test("connections have expected fields", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections");
    expect(res.status).toBe(200);

    const data = await res.json();
    if (data.connections.length > 0) {
      const conn = data.connections[0];
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("applicationId");
      expect(conn).toHaveProperty("status");
      expect(conn).toHaveProperty("isActive");
      expect(conn).toHaveProperty("createdAt");
    }
  });
});

describe("Discord Connections Create API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(`${SERVER_URL}/api/v1/discord/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        applicationId: "123456789",
        botToken: "test-token",
        characterId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 400 for missing applicationId", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      botToken: "test-token",
      characterId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
    expect(data).toHaveProperty("error");
  });

  test("returns 400 for missing botToken", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: "123456789",
      characterId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
  });

  test("returns 400 for missing characterId", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: "123456789",
      botToken: "test-token",
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
  });

  test("returns 400 for invalid characterId format", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: "123456789",
      botToken: "test-token",
      characterId: "not-a-uuid",
    });
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
  });

  test("returns 404 for non-existent characterId", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: "123456789",
      botToken: "test-token",
      characterId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
    expect(data).toHaveProperty("error", "Character not found");
  });

  test("returns 400 for invalid metadata (keyword mode without keywords)", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: `test-${Date.now()}`,
      botToken: "test-token-" + Date.now(),
      characterId: TEST_CHARACTER_ID,
      metadata: {
        responseMode: "keyword",
        // keywords missing
      },
    });
    expect(res.status).toBe(400);
  });

  test("creates connection with valid payload", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    const applicationId = `test-app-${Date.now()}`;
    const res = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId,
      botToken: `test-token-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
      metadata: {
        responseMode: "always",
      },
    });

    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("connection");
    expect(data.connection).toHaveProperty("id");
    expect(data.connection).toHaveProperty("applicationId", applicationId);
    expect(data.connection).toHaveProperty("characterId", TEST_CHARACTER_ID);
    expect(data.connection).toHaveProperty("status", "pending");
    expect(data).toHaveProperty("message");

    // Track for cleanup
    if (data.connection?.id) {
      createdConnectionIds.push(data.connection.id);
    }
  });

  test("returns 409 for duplicate applicationId", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    const applicationId = `test-duplicate-${Date.now()}`;

    // Create first connection
    const res1 = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId,
      botToken: `test-token-1-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
    });
    expect(res1.status).toBe(200);

    const data1 = await res1.json();
    if (data1.connection?.id) {
      createdConnectionIds.push(data1.connection.id);
    }

    // Try to create duplicate
    const res2 = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId,
      botToken: `test-token-2-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
    });
    expect(res2.status).toBe(409);

    const data2 = await res2.json();
    expect(data2).toHaveProperty("success", false);
    expect(data2).toHaveProperty("existingConnectionId");
  });
});

describe("Discord Connections Get by ID API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(
      `${SERVER_URL}/api/v1/discord/connections/550e8400-e29b-41d4-a716-446655440000`,
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 for non-existent connection", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth(
      "/api/v1/discord/connections/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data).toHaveProperty("success", false);
    expect(data).toHaveProperty("error", "Connection not found");
  });

  test("returns connection details for valid ID", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    // First create a connection
    const applicationId = `test-get-${Date.now()}`;
    const createRes = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId,
      botToken: `test-token-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
    });

    if (createRes.status !== 200) return;

    const createData = await createRes.json();
    const connectionId = createData.connection.id;
    createdConnectionIds.push(connectionId);

    // Now get the connection
    const res = await fetchWithAuth(`/api/v1/discord/connections/${connectionId}`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("connection");
    expect(data.connection).toHaveProperty("id", connectionId);
    expect(data.connection).toHaveProperty("applicationId", applicationId);
  });
});

describe("Discord Connections Update API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(
      `${SERVER_URL}/api/v1/discord/connections/550e8400-e29b-41d4-a716-446655440000`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      },
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 for non-existent connection", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth(
      "/api/v1/discord/connections/00000000-0000-0000-0000-000000000000",
      "PATCH",
      { isActive: false },
    );
    expect(res.status).toBe(404);
  });

  test("updates isActive field", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    // First create a connection
    const createRes = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: `test-update-${Date.now()}`,
      botToken: `test-token-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
    });

    if (createRes.status !== 200) return;

    const createData = await createRes.json();
    const connectionId = createData.connection.id;
    createdConnectionIds.push(connectionId);

    // Update the connection
    const res = await fetchWithAuth(`/api/v1/discord/connections/${connectionId}`, "PATCH", {
      isActive: false,
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data.connection).toHaveProperty("isActive", false);
  });

  test("updates metadata field", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    // First create a connection
    const createRes = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: `test-update-meta-${Date.now()}`,
      botToken: `test-token-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
      metadata: { responseMode: "always" },
    });

    if (createRes.status !== 200) return;

    const createData = await createRes.json();
    const connectionId = createData.connection.id;
    createdConnectionIds.push(connectionId);

    // Update the metadata
    const res = await fetchWithAuth(`/api/v1/discord/connections/${connectionId}`, "PATCH", {
      metadata: { responseMode: "mention" },
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data.connection.metadata).toHaveProperty("responseMode", "mention");
  });
});

describe("Discord Connections Delete API", () => {
  test("returns 401 without auth", async () => {
    const res = await fetch(
      `${SERVER_URL}/api/v1/discord/connections/550e8400-e29b-41d4-a716-446655440000`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });

  test("returns 404 for non-existent connection", async () => {
    if (!apiKeyValid) return;

    const res = await fetchWithAuth(
      "/api/v1/discord/connections/00000000-0000-0000-0000-000000000000",
      "DELETE",
    );
    expect(res.status).toBe(404);
  });

  test("deletes existing connection", async () => {
    if (!apiKeyValid || !hasTestCharacter) return;

    // First create a connection
    const createRes = await fetchWithAuth("/api/v1/discord/connections", "POST", {
      applicationId: `test-delete-${Date.now()}`,
      botToken: `test-token-${Date.now()}`,
      characterId: TEST_CHARACTER_ID,
    });

    if (createRes.status !== 200) return;

    const createData = await createRes.json();
    const connectionId = createData.connection.id;

    // Delete the connection
    const res = await fetchWithAuth(`/api/v1/discord/connections/${connectionId}`, "DELETE");
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("message");

    // Verify it's deleted
    const getRes = await fetchWithAuth(`/api/v1/discord/connections/${connectionId}`);
    expect(getRes.status).toBe(404);
  });
});
