import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type McpRegistryResponse =
  | {
      registry?: unknown[];
    }
  | unknown[];

/**
 * OAuth, Connections, MCPs & Documents API E2E Tests
 */

describe("OAuth API", () => {
  test("GET /api/v1/oauth/connections returns connections list", async () => {
    const response = await api.get("/api/v1/oauth/connections");
    expect([200, 401, 403]).toContain(response.status);
  });

  test("GET /api/v1/oauth/connections/[id] handles nonexistent", async () => {
    const response = await api.get(
      "/api/v1/oauth/connections/00000000-0000-4000-8000-000000000000",
    );
    expect([404, 401, 403]).toContain(response.status);
  });
});

describe("Platform Connections API", () => {
  test("POST /api/v1/connections/twilio requires auth", async () => {
    const response = await api.post("/api/v1/connections/twilio", {
      accountSid: "AC123",
      authToken: "test-token",
      phoneNumber: "+15551234567",
    });
    expect([401, 403]).toContain(response.status);
  });

  test("POST /api/v1/connections/github returns unsupported platform", async () => {
    const response = await api.post("/api/v1/connections/github", {}, { authenticated: true });
    expect([404, 501]).toContain(response.status);
  });
});

describe("MCPs API", () => {
  test("GET /api/v1/mcps requires auth", async () => {
    const response = await api.get("/api/v1/mcps");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/mcp/registry returns public registry", async () => {
    const response = await api.get("/api/mcp/registry");
    expect(response.status).toBe(200);
    const body = await readJson<McpRegistryResponse>(response);
    const hasRegistry = Array.isArray(body) || Array.isArray(body.registry);
    expect(hasRegistry).toBe(true);
  });
});

describe("Documents API", () => {
  test("GET /api/v1/documents requires auth", async () => {
    const response = await api.get("/api/v1/documents");
    expect([401, 403, 404]).toContain(response.status);
  });
});

describe("Discord Connections API", () => {
  test("GET /api/v1/discord/connections requires auth", async () => {
    const response = await api.get("/api/v1/discord/connections");
    expect([401, 403]).toContain(response.status);
  });
});
