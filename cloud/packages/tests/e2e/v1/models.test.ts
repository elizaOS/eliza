import { describe, expect, test } from "bun:test";
import * as api from "../helpers/api-client";
import { readJson } from "../helpers/json-body";

type ErrorResponse = {
  error?: unknown;
};

describe("Models API", () => {
  test("GET /api/v1/models returns model list", async () => {
    const response = await api.get("/api/v1/models");
    expect(response.status).toBe(200);

    expect(response.headers.get("cache-control")).toContain("s-maxage");
    const body = (await response.json()) as { data?: unknown; models?: unknown };
    expect(body.data || body.models || Array.isArray(body)).toBeTruthy();
  });

  test("GET /api/v1/models returns models with auth", async () => {
    const response = await api.get("/api/v1/models", {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data?: unknown; models?: unknown };
    const models = body.data || body.models || body;
    if (!Array.isArray(models)) {
      throw new Error("Expected /api/v1/models to return an array-shaped model payload");
    }
    expect(models.length).toBeGreaterThan(0);
  });

  test("POST /api/v1/models/status returns status", async () => {
    const response = await api.post("/api/v1/models/status", {
      modelIds: ["google/gemini-2.5-flash"],
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { models?: unknown };
    expect(Array.isArray(body.models)).toBe(true);
  });
});

describe("Responses API", () => {
  test("POST /api/v1/responses supports auth or anonymous fallback", async () => {
    const response = await api.post("/api/v1/responses", {
      model: "google/gemini-2.5-flash",
      input: [{ role: "user", content: "Hello" }],
    });
    expect([200, 401, 402, 403, 503]).toContain(response.status);
  });

  test("POST /api/v1/responses rejects malformed requests", async () => {
    const response = await api.post("/api/v1/responses", {});
    expect([400, 401, 403]).toContain(response.status);

    if (response.status === 400) {
      const body = await readJson<ErrorResponse>(response);
      expect(body.error).toBeTruthy();
    }
  });

  test("POST /api/v1/responses accepts valid input", async () => {
    const response = await api.post(
      "/api/v1/responses",
      {
        model: "google/gemini-2.5-flash",
        input: [{ role: "user", content: "Say hello" }],
      },
      { authenticated: true },
    );
    expect([200, 401, 402, 503]).toContain(response.status);
  });
});
