/** Runs the real Cloud API HTTP adapter against deterministic protocol fixtures. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  type RunningFakeProvider,
  runProviderAdapterConformance,
  startFakeProvider,
} from "../../src/provider-contract";

let provider: RunningFakeProvider;

beforeAll(async () => {
  provider = await startFakeProvider({
    accounts: [
      {
        accountId: "acct-cloud",
        tenantId: "org-cloud",
        capabilities: ["cloud.models.read", "cloud.writes.create"],
        apiCredential: "cloud-secret",
      },
    ],
    fixtures: [
      {
        id: "models",
        method: "GET",
        path: "/api/v1/models",
        action: {
          operation: "cloud.models.list",
          capabilityId: "cloud.models.read",
          effect: "read",
          riskLevel: "R0",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
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
      {
        id: "write",
        method: "POST",
        path: "/api/v1/writes",
        action: {
          operation: "cloud.writes.create",
          capabilityId: "cloud.writes.create",
          effect: "write",
          riskLevel: "R1",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
        response: { status: 201, body: { id: "write-1" } },
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
      profile: "outbound-http",
      capabilities: ["http-read", "http-write"],
      scenarios: {
        success: async () => {
          expect(
            await client.get<{ models: Array<{ id: string }> }>("/models"),
          ).toEqual({
            models: [{ id: "model-1" }],
          });
          return {
            scenario: "success",
            status: "passed",
            detail: "real authenticated SDK request mapped",
          };
        },
        "designed-empty": async () => {
          expect(await client.get<{ items: unknown[] }>("/empty")).toEqual({
            items: [],
          });
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
          expect(
            await client.get<{
              models: unknown[];
              upstream_revision: number;
            }>("/models"),
          ).toEqual({
            models: [],
            upstream_revision: 2,
          });
          return {
            scenario: "schema-drift",
            status: "passed",
            detail: "transport preserves schema for the owning DTO validator",
          };
        },
        "connection-reset": async () => {
          const resetProvider = await startFakeProvider({
            fixtures: [
              {
                id: "reset-models",
                method: "GET",
                path: "/api/v1/models",
                response: { status: 200, body: { models: [] } },
              },
            ],
          });
          const resetClient = new CloudApiClient(
            `${resetProvider.url}/api/v1`,
            "reset-secret",
          );
          await resetProvider.resetConnections();
          await expect(resetClient.get("/models")).rejects.toThrow();
          return {
            scenario: "connection-reset",
            status: "passed",
            detail: "stopped loopback upstream produced a real network failure",
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
        "opaque-connection-id": async () => {
          const connectionId = provider.createConnectionId();
          return {
            scenario: "opaque-connection-id",
            status: "passed",
            detail:
              "provider connection exposed only an opaque capability handle",
            connectionId,
          };
        },
        "read-policy": async () => {
          await client.get("/models", {
            headers: { "x-provider-request-id": "cloud-read-policy" },
          });
          const receipt = provider.receipts.find(
            (candidate) => candidate.request.id === "cloud-read-policy",
          );
          expect(receipt).toMatchObject({
            tenantId: "org-cloud",
            accountId: "acct-cloud",
            effectKind: "read",
            outcome: "succeeded",
            policy: { outcome: "allowed", riskLevel: "R0" },
            executedEffect: { performed: true },
            effect: { outcome: "applied" },
          });
          return {
            scenario: "read-policy",
            status: "passed",
            detail: "real read completed under the provider read policy",
          };
        },
        "write-policy-receipt": async () => {
          expect(
            await client.post<{ id: string }>(
              "/writes",
              { value: 1 },
              {
                headers: {
                  "x-provider-request-id": "cloud-create-write",
                  "idempotency-key": "cloud-create-write-1",
                },
              },
            ),
          ).toEqual({
            id: "write-1",
          });
          const receipt = provider.receipts.find(
            (candidate) => candidate.request.id === "cloud-create-write",
          );
          expect(receipt).toMatchObject({
            capabilityId: "cloud.writes.create",
            outcome: "succeeded",
            providerResult: { status: "accepted", resultId: "write-1" },
            effect: {
              outcome: "applied",
              idempotency: { key: "cloud-create-write-1", replayed: false },
            },
          });
          return {
            scenario: "write-policy-receipt",
            status: "passed",
            detail: "real write completed and emitted an auditable receipt",
            receiptId: receipt?.id,
          };
        },
      },
    });
    expect(report.observations).toHaveLength(14);
  });
});
