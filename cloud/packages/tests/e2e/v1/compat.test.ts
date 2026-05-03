import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { NONEXISTENT_UUID } from "../helpers/test-data";

/**
 * Compat API E2E Tests (Backward-compatible agent endpoints)
 *
 * Note: Compat routes are at /api/compat/ NOT /api/v1/compat/
 */

describe("Compat Agents API", () => {
  test("GET /api/compat/agents requires auth", async () => {
    const response = await api.get("/api/compat/agents");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/compat/agents returns agents list", async () => {
    const response = await api.get("/api/compat/agents", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
  });

  test("GET /api/compat/agents/[id] handles nonexistent", async () => {
    const response = await api.get(`/api/compat/agents/${NONEXISTENT_UUID}`);
    expect([404, 401, 403]).toContain(response.status);
  });

  test("GET /api/compat/agents/[id]/status handles nonexistent", async () => {
    const response = await api.get(`/api/compat/agents/${NONEXISTENT_UUID}/status`);
    expect([404, 401, 403]).toContain(response.status);
  });

  test("GET /api/compat/agents/[id]/logs handles nonexistent", async () => {
    const response = await api.get(`/api/compat/agents/${NONEXISTENT_UUID}/logs`);
    expect([404, 401, 403]).toContain(response.status);
  });

  test("POST /api/compat/agents/[id]/restart requires auth", async () => {
    const response = await api.post(`/api/compat/agents/${NONEXISTENT_UUID}/restart`);
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/compat/agents/[id]/resume requires auth", async () => {
    const response = await api.post(`/api/compat/agents/${NONEXISTENT_UUID}/resume`);
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/compat/agents/[id]/suspend requires auth", async () => {
    const response = await api.post(`/api/compat/agents/${NONEXISTENT_UUID}/suspend`);
    expect([401, 403]).toContain(response.status);
  });
});

describe("Compat Availability API", () => {
  test("GET /api/compat/availability responds", async () => {
    const response = await api.get("/api/compat/availability");
    expect([200, 401]).toContain(response.status);
  });
});

describe("Compat Jobs API", () => {
  test("GET /api/compat/jobs/[id] handles nonexistent", async () => {
    const response = await api.get(`/api/compat/jobs/${NONEXISTENT_UUID}`);
    expect([404, 401, 403]).toContain(response.status);
  });
});
