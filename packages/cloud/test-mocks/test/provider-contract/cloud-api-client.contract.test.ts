/** Runs the real Cloud API HTTP adapter against deterministic protocol fixtures. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CloudApiClient } from "../../../sdk/src/http.js";
import {
  type RunningFakeProvider,
  runProviderAdapterConformance,
  startFakeProvider,
} from "../../src/provider-contract";

let provider: RunningFakeProvider;

beforeAll(async () => {
  provider = await startFakeProvider({
    fixtures: [
      {
        id: "models",
        method: "GET",
        path: "/api/v1/models",
        response: { status: 200, body: { models: [{ id: "model-1" }] } },
      },
      {
        id: "empty",
        method: "GET",
        path: "/api/v1/empty",
        response: { status: 200, body: { items: [] } },
      },
      {
        id: "invalid",
        method: "POST",
        path: "/api/v1/items",
        response: {
          status: 422,
          body: {
            error: { code: "invalid_input", message: "name is required" },
          },
        },
      },
      {
        id: "rate",
        method: "GET",
        path: "/api/v1/rate",
        response: {
          status: 429,
          headers: { "retry-after": "4" },
          body: { error: { code: "rate_limited", message: "slow down" } },
        },
      },
    ],
  });
});

afterAll(async () => {
  await provider.stop();
});

describe("CloudApiClient provider contract", () => {
  test("exercises response and transport failures without replacing the client", async () => {
    const client = new CloudApiClient(`${provider.url}/api/v1`, "cloud-secret");
    const report = await runProviderAdapterConformance({
      adapterName: "CloudApiClient",
      capabilities: ["http-read", "http-write"],
      requiredScenarios: [
        "success",
        "designed-empty",
        "invalid-input",
        "rate-limit-retry-metadata",
        "malformed-json",
        "schema-drift",
        "timeout",
        "provider-4xx",
        "provider-5xx",
        "secret-redaction",
      ],
      scenarios: {
        success: async () => {
          expect(await client.get("/models")).toEqual({
            models: [{ id: "model-1" }],
          });
          return {
            scenario: "success",
            status: "passed",
            detail: "real authenticated SDK request mapped",
          };
        },
        "designed-empty": async () => {
          expect(await client.get("/empty")).toEqual({ items: [] });
          return {
            scenario: "designed-empty",
            status: "passed",
            detail: "designed empty response retained",
          };
        },
        "invalid-input": async () => {
          await expect(client.post("/items", {})).rejects.toMatchObject({
            statusCode: 422,
            errorBody: { code: "invalid_input" },
          });
          return {
            scenario: "invalid-input",
            status: "passed",
            detail: "422 body retained in CloudApiError",
          };
        },
        "rate-limit-retry-metadata": async () => {
          const raw = await client.requestRaw("GET", "/rate");
          expect(raw.status).toBe(429);
          expect(raw.headers.get("retry-after")).toBe("4");
          return {
            scenario: "rate-limit-retry-metadata",
            status: "passed",
            detail: "raw response exposes retry-after metadata",
          };
        },
        "malformed-json": async () => {
          provider.enqueueFault("GET", "/api/v1/models", {
            type: "malformed-json",
          });
          await expect(client.get("/models")).rejects.toMatchObject({
            statusCode: 200,
          });
          return {
            scenario: "malformed-json",
            status: "passed",
            detail: "malformed success response rejected",
          };
        },
        "schema-drift": async () => {
          provider.enqueueFault("GET", "/api/v1/models", {
            type: "schema-drift",
            body: { models: [], upstream_revision: 2 },
          });
          expect(await client.get("/models")).toEqual({
            models: [],
            upstream_revision: 2,
          });
          return {
            scenario: "schema-drift",
            status: "passed",
            detail: "transport preserves schema for the owning DTO validator",
          };
        },
        timeout: async () => {
          provider.enqueueFault("GET", "/api/v1/models", {
            type: "delay",
            durationMs: 100,
          });
          await expect(
            client.get("/models", { timeoutMs: 5 }),
          ).rejects.toThrow();
          return {
            scenario: "timeout",
            status: "passed",
            detail: "SDK timeout signal aborted loopback transport",
          };
        },
        "provider-4xx": async () => {
          provider.enqueueFault("GET", "/api/v1/models", {
            type: "status",
            status: 403,
            body: { error: { code: "tenant_denied", message: "denied" } },
          });
          await expect(client.get("/models")).rejects.toMatchObject({
            statusCode: 403,
            errorBody: { code: "tenant_denied" },
          });
          return {
            scenario: "provider-4xx",
            status: "passed",
            detail: "403 surfaced with provider code",
          };
        },
        "provider-5xx": async () => {
          provider.enqueueFault("GET", "/api/v1/models", {
            type: "status",
            status: 502,
            body: { error: { code: "bad_gateway", message: "down" } },
          });
          await expect(client.get("/models")).rejects.toMatchObject({
            statusCode: 502,
          });
          return {
            scenario: "provider-5xx",
            status: "passed",
            detail: "502 surfaced without fabricated response",
          };
        },
        "secret-redaction": async () => {
          expect(JSON.stringify(provider.requests)).not.toContain(
            "cloud-secret",
          );
          return {
            scenario: "secret-redaction",
            status: "passed",
            detail: "fake upstream capture redacted SDK auth headers",
            diagnostic: provider.requests.at(-1),
          };
        },
      },
    });
    expect(report.observations).toHaveLength(10);
  });
});
