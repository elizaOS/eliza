import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

let failure: ApiError;
let authCalls = 0;
mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => {
    authCalls++;
    throw failure;
  },
}));

const lookup = spyOn(charactersService, "getById");
const cachedLookup = spyOn(charactersService, "getByIdCacheOnly");
const { default: route } = await import("../agents/[id]/a2a/route");
const app = new Hono().route("/api/agents/:id/a2a", route);

beforeEach(() => {
  authCalls = 0;
  lookup.mockClear();
  cachedLookup.mockClear();
});
afterAll(() => {
  lookup.mockRestore();
  cachedLookup.mockRestore();
});

test("A2A preserves only the pre-admission auth warming marker and retry delay", async () => {
  for (const code of ["auth_cache_warming", "service_unavailable"] as const) {
    failure = new ApiError(503, code, "Synthetic refusal", {
      retryable: true,
      retryAfterSeconds: 1,
    });
    const response = await app.request(
      "/api/agents/00000000-0000-4000-8000-000000000000/a2a",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "chat", id: 1 }),
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32004,
        message: "Authorization cache unavailable; retry shortly",
        ...(code === "auth_cache_warming"
          ? { data: { code: "auth_cache_warming" } }
          : {}),
      },
      id: null,
    });
    expect(response.headers.get("Retry-After")).toBe(
      code === "auth_cache_warming" ? "1" : null,
    );
  }
  expect(authCalls).toBe(2);
  expect(lookup).not.toHaveBeenCalled();
  expect(cachedLookup).not.toHaveBeenCalled();
});
