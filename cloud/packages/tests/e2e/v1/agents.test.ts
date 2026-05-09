import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";
import { NONEXISTENT_UUID } from "../helpers/test-data";

type ContainersResponse =
  | {
      data?: unknown[];
      containers?: unknown[];
    }
  | unknown[];

/**
 * Agents API E2E Tests
 *
 * Note: /api/v1/agents root only has POST (create agent).
 * Agent listing is typically via the dashboard or compat API.
 */

describe("Agents API", () => {
  describe("Create Agent", () => {
    test("POST /api/v1/agents requires auth", async () => {
      const response = await api.post("/api/v1/agents", {
        name: "test-agent",
      });
      expect([401, 403]).toContain(response.status);
    });
  });

  describe("Agent by ID", () => {
    test("GET /api/v1/agents/[id] returns 404 for nonexistent", async () => {
      const response = await api.get(`/api/v1/agents/${NONEXISTENT_UUID}`, {
        authenticated: true,
      });
      expect([404, 401]).toContain(response.status);
    });
  });

  describe("Agent Actions", () => {
    test("POST /api/v1/agents/[id]/restart requires auth", async () => {
      const response = await api.post(`/api/v1/agents/${NONEXISTENT_UUID}/restart`);
      expect([401, 403]).toContain(response.status);
    });

    test("GET /api/v1/agents/[id]/status requires auth", async () => {
      const response = await api.get(`/api/v1/agents/${NONEXISTENT_UUID}/status`);
      expect([401, 403]).toContain(response.status);
    });

    test("GET /api/v1/agents/[id]/logs requires auth", async () => {
      const response = await api.get(`/api/v1/agents/${NONEXISTENT_UUID}/logs`);
      expect([401, 403]).toContain(response.status);
    });
  });

  describe("Agent A2A", () => {
    test("POST /api/v1/agents/[id]/a2a returns valid response", async () => {
      const response = await api.post(`/api/v1/agents/${NONEXISTENT_UUID}/a2a`, {
        message: { text: "test" },
      });
      expect([200, 401, 404]).toContain(response.status);
    });
  });

  describe("Agent MCP", () => {
    test("POST /api/v1/agents/[id]/mcp returns valid response", async () => {
      const response = await api.post(`/api/v1/agents/${NONEXISTENT_UUID}/mcp`, {
        method: "tools/list",
      });
      expect([200, 401, 404]).toContain(response.status);
    });
  });
});

describe("Containers API", () => {
  test("GET /api/v1/containers requires auth", async () => {
    const response = await api.get("/api/v1/containers");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/containers returns container list", async () => {
    const response = await api.get("/api/v1/containers", {
      authenticated: true,
    });
    expect(response.status).toBe(200);
    const body = await readJson<ContainersResponse>(response);
    const containers = Array.isArray(body) ? body : (body.data ?? body.containers ?? []);
    expect(Array.isArray(containers)).toBe(true);
  });

  test("GET /api/v1/containers/[id] returns 404 for nonexistent", async () => {
    const response = await api.get(`/api/v1/containers/${NONEXISTENT_UUID}`, {
      authenticated: true,
    });
    expect([404, 401]).toContain(response.status);
  });
});
