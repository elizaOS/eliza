import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type UserResponse = {
  success: boolean;
  data?: {
    id?: string;
  };
};

type UserErrorResponse = {
  error?: unknown;
};

/**
 * User API E2E Tests
 */

describe("User API", () => {
  test("GET /api/v1/user requires authentication", async () => {
    const response = await api.get("/api/v1/user");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/user returns user data with API key", async () => {
    const response = await api.get("/api/v1/user", { authenticated: true });
    expect(response.status).toBe(200);

    const body = await readJson<UserResponse>(response);
    expect(body.success).toBe(true);
    expect(body.data?.id).toBeTruthy();
  });

  test("PATCH /api/v1/user requires authentication", async () => {
    const response = await api.patch("/api/v1/user", { name: "test" });
    expect([401, 403]).toContain(response.status);
  });

  test("PATCH /api/v1/user rejects invalid authenticated updates", async () => {
    const response = await api.patch(
      "/api/v1/user",
      { work_function: "astronaut" },
      { authenticated: true },
    );

    expect(response.status).toBe(400);
    const body = await readJson<UserErrorResponse>(response);
    expect(body.error).toBeTruthy();
  });
});
