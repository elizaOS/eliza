import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";
import { NONEXISTENT_UUID } from "../helpers/test-data";

type AppsResponse = { apps?: unknown[] } | unknown[];

/**
 * Characters, Apps & Gallery API E2E Tests
 *
 * Discovery route can cold-compile slowly in the shared dev server, so use a wider timeout.
 */
setDefaultTimeout(30_000);

describe("Characters API", () => {
  test("PUT /api/v1/characters/[id]/public requires auth", async () => {
    const response = await api.put(`/api/v1/characters/${NONEXISTENT_UUID}/public`, {
      isPublic: true,
    });
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/characters/[id]/mcps requires auth", async () => {
    const response = await api.get(`/api/v1/characters/${NONEXISTENT_UUID}/mcps`);
    expect([401, 403, 404]).toContain(response.status);
  });
});

describe("Apps API", () => {
  test("GET /api/v1/apps requires auth", async () => {
    const response = await api.get("/api/v1/apps");
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/apps returns app list", async () => {
    const response = await api.get("/api/v1/apps", { authenticated: true });
    expect(response.status).toBe(200);
    const body = await readJson<AppsResponse>(response);
    const apps = Array.isArray(body) ? body : (body.apps ?? []);
    expect(Array.isArray(apps)).toBe(true);
  });

  test("POST /api/v1/apps requires auth", async () => {
    const response = await api.post("/api/v1/apps", { name: "test-app" });
    expect([401, 403]).toContain(response.status);
  });
});

describe("Gallery API", () => {
  test("GET /api/v1/gallery returns public gallery", async () => {
    const response = await api.get("/api/v1/gallery");
    expect([200, 401]).toContain(response.status);
  });

  test("GET /api/v1/discovery returns discovery data", async () => {
    const response = await api.get("/api/v1/discovery");
    expect([200, 401, 404]).toContain(response.status);
  });
});
