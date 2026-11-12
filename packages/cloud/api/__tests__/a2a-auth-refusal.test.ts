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
const { default: route } = await import("../agents/[id]/a2a/route");
const app = new Hono().route("/api/agents/:id/a2a", route);

beforeEach(() => {
  authCalls = 0;
  lookup.mockClear();
});
afterAll(() => {
  lookup.mockRestore();
});

test("A2A maps a retryable auth refusal to a retryable JSON-RPC error before agent lookup", async () => {
  for (const code of ["service_unavailable"] as const) {
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
        message: "Authorization is unavailable; retry shortly",
      },
      id: null,
    });
    expect(response.headers.get("Retry-After")).toBe("1");
  }
  expect(authCalls).toBe(1);
  expect(lookup).not.toHaveBeenCalled();
});
