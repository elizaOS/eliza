import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";

/**
 * API Keys E2E Tests
 *
 * Root: GET (list), POST (create)
 * [id]: DELETE (revoke), [id]/regenerate: POST
 */

describe("API Keys API", () => {
  test("GET /api/v1/api-keys requires authentication", async () => {
    const response = await api.get("/api/v1/api-keys");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/api-keys returns key list with auth", async () => {
    const response = await api.get("/api/v1/api-keys", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as any;
    expect(Array.isArray(body.apiKeys || body.keys || body)).toBe(true);
  });

  test("POST /api/v1/api-keys requires authentication", async () => {
    const response = await api.post("/api/v1/api-keys", {
      name: "test-key",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/api-keys rejects invalid authenticated payloads", async () => {
    const response = await api.post(
      "/api/v1/api-keys",
      {
        name: "",
        rate_limit: 0,
      },
      { authenticated: true },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toBeTruthy();
  });

  test("DELETE /api/v1/api-keys/[id] requires authentication", async () => {
    const response = await api.del("/api/v1/api-keys/00000000-0000-4000-8000-000000000000");
    expect([401, 403]).toContain(response.status);
  });
});
