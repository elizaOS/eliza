import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type CliSessionResponse = {
  sessionId?: string;
  id?: string;
};

/**
 * CLI Auth Session E2E Tests
 *
 * Tests the CLI login flow:
 * 1. CLI creates a session (POST /api/auth/cli-session)
 * 2. CLI polls for completion (GET /api/auth/cli-session/[id])
 * 3. Browser completes auth (POST /api/auth/cli-session/[id]/complete)
 */

describe("CLI Auth API", () => {
  test("POST /api/auth/cli-session creates a pending session", async () => {
    const response = await api.post("/api/auth/cli-session", {
      sessionId: `e2e-cli-session-${Date.now()}`,
    });

    expect([200, 201]).toContain(response.status);

    if (response.status === 200 || response.status === 201) {
      const body = await readJson<CliSessionResponse>(response);
      expect(body.sessionId || body.id).toBeTruthy();
    }
  });

  test("GET /api/auth/cli-session/[id] returns 404 for nonexistent session", async () => {
    const response = await api.get("/api/auth/cli-session/nonexistent-session-id");
    expect([404, 400]).toContain(response.status);
  });

  test("POST /api/auth/cli-session/[id]/complete requires auth", async () => {
    const response = await api.post("/api/auth/cli-session/test-session/complete");
    // Should require authenticated user to complete
    expect([401, 403, 404]).toContain(response.status);
  });
});
