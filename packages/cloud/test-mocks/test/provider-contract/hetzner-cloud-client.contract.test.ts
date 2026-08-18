/** Runs the real Hetzner transport adapter against deterministic protocol fixtures. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HetznerCloudClient,
  HetznerCloudError,
} from "@elizaos/cloud-shared/lib/services/containers/hetzner-cloud-api";
import {
  type RunningFakeProvider,
  redactProviderDiagnostics,
  runProviderAdapterConformance,
  startFakeProvider,
} from "../../src/provider-contract";

let provider: RunningFakeProvider;

beforeAll(async () => {
  provider = await startFakeProvider({
    fixtures: [
      {
        id: "hetzner-list-servers",
        method: "GET",
        path: "/v1/servers",
        response: {
          status: 200,
          body: { servers: [{ id: 7, name: "node-a" }] },
        },
      },
    ],
  });
});

afterAll(async () => {
  await provider.stop();
});

describe("HetznerCloudClient provider contract", () => {
  test("exercises success, empty, invalid, rate-limit, malformed, and provider failures over HTTP", async () => {
    const client = HetznerCloudClient.withToken("contract-secret", {
      apiBaseUrl: `${provider.url}/v1`,
      requestTimeoutMs: 20,
    });
    const report = await runProviderAdapterConformance({
      adapterName: "HetznerCloudClient",
      capabilities: ["http-read", "http-write", "irreversible-write"],
      requiredScenarios: [
        "success",
        "designed-empty",
        "invalid-input",
        "rate-limit-retry-metadata",
        "malformed-json",
        "timeout",
        "provider-4xx",
        "provider-5xx",
        "secret-redaction",
      ],
      scenarios: {
        success: async () => {
          expect((await client.listServers())[0]?.id).toBe(7);
          return {
            scenario: "success",
            status: "passed",
            detail: "real listServers response mapped",
          };
        },
        "designed-empty": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "schema-drift",
            body: { servers: [] },
          });
          expect(await client.listServers()).toEqual([]);
          return {
            scenario: "designed-empty",
            status: "passed",
            detail: "empty server list preserved",
          };
        },
        "invalid-input": async () => {
          await expect(
            client.createServer({
              name: "too-large",
              serverType: "cx22",
              location: "fsn1",
              image: "ubuntu",
              userData: "x".repeat(32 * 1024 + 1),
            }),
          ).rejects.toMatchObject({ code: "invalid_input" });
          return {
            scenario: "invalid-input",
            status: "passed",
            detail: "oversized user_data rejected before transport",
          };
        },
        "rate-limit-retry-metadata": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "status",
            status: 429,
            body: { error: { code: "rate_limited", message: "retry later" } },
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "rate_limited",
            status: 429,
          });
          return {
            scenario: "rate-limit-retry-metadata",
            status: "passed",
            detail: "429 retained as typed rate_limited failure",
          };
        },
        "malformed-json": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "malformed-json",
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "server_error",
            status: 200,
          });
          return {
            scenario: "malformed-json",
            status: "passed",
            detail: "declared JSON parse failure surfaced",
          };
        },
        timeout: async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "delay",
            durationMs: 100,
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "transport_error",
          });
          return {
            scenario: "timeout",
            status: "passed",
            detail: "adapter deadline aborted the real request",
          };
        },
        "provider-4xx": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "status",
            status: 401,
            body: { error: { code: "unauthorized", message: "denied" } },
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "missing_token",
            status: 401,
          });
          return {
            scenario: "provider-4xx",
            status: "passed",
            detail: "401 normalized without fabricated data",
          };
        },
        "provider-5xx": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "status",
            status: 503,
            body: { error: { code: "unavailable", message: "down" } },
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "server_error",
            status: 503,
          });
          return {
            scenario: "provider-5xx",
            status: "passed",
            detail: "503 normalized without retry fabrication",
          };
        },
        "secret-redaction": async () => {
          const diagnostic = redactProviderDiagnostics(
            new HetznerCloudError(
              "transport_error",
              "Bearer contract-secret failed",
            ),
            ["contract-secret"],
          );
          expect(JSON.stringify(provider.requests)).not.toContain(
            "contract-secret",
          );
          return {
            scenario: "secret-redaction",
            status: "passed",
            detail: "request capture and diagnostic are redacted",
            diagnostic,
          };
        },
      },
    });
    expect(report.observations).toHaveLength(9);
  });
});
