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
    accounts: [
      {
        accountId: "acct-hetzner",
        tenantId: "org-hetzner",
        capabilities: [
          "hetzner.servers.read",
          "hetzner.servers.create",
          "hetzner.servers.delete",
        ],
        apiCredential: "contract-secret",
      },
    ],
    fixtures: [
      {
        id: "hetzner-list-servers",
        method: "GET",
        path: "/v1/servers",
        action: {
          operation: "hetzner.servers.list",
          capabilityId: "hetzner.servers.read",
          effect: "read",
          riskLevel: "R0",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
        response: {
          status: 200,
          body: {
            servers: [{ id: 7, name: "node-a" }],
            meta: { pagination: { next_page: null } },
          },
        },
      },
      {
        id: "hetzner-create-server",
        method: "POST",
        path: "/v1/servers",
        action: {
          operation: "hetzner.servers.create",
          capabilityId: "hetzner.servers.create",
          effect: "write",
          riskLevel: "R2",
          decision: "allow",
          confirmation: { state: "already_granted" },
        },
        response: {
          status: 201,
          body: {
            server: { id: 8, name: "node-b", public_net: {} },
            root_password: null,
          },
        },
      },
      {
        id: "hetzner-delete-server",
        method: "DELETE",
        path: "/v1/servers/7",
        action: {
          operation: "hetzner.servers.delete",
          capabilityId: "hetzner.servers.delete",
          effect: "irreversible",
          riskLevel: "R3",
          decision: "allow",
          confirmation: { state: "already_granted" },
        },
        response: { status: 204 },
      },
    ],
  });
});

afterAll(async () => {
  await provider.stop();
});

describe("HetznerCloudClient provider contract", () => {
  test("exercises success, empty, invalid, rate-limit, malformed, and provider failures over HTTP", async () => {
    const client = HetznerCloudClient.withTestTransport("contract-secret", {
      apiBaseUrl: `${provider.url}/v1`,
      requestTimeoutMs: 1_000,
    });
    const report = await runProviderAdapterConformance({
      adapterName: "HetznerCloudClient",
      profile: "outbound-http",
      capabilities: ["http-read", "http-write", "irreversible-write"],
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
            body: {
              servers: [],
              meta: { pagination: { next_page: null } },
            },
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
            headers: {
              "retry-after": "7",
              "x-ratelimit-reset": "1786934400",
            },
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "rate_limited",
            status: 429,
            retry: {
              retryAfterSeconds: 7,
              resetAtEpochSeconds: 1_786_934_400,
            },
          });
          return {
            scenario: "rate-limit-retry-metadata",
            status: "passed",
            detail:
              "429 retained with normalized retry-after and reset metadata",
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
        "schema-drift": async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "schema-drift",
            body: { renamed_servers: [] },
          });
          await expect(client.listServers()).rejects.toMatchObject({
            code: "server_error",
          });
          return {
            scenario: "schema-drift",
            status: "passed",
            detail: "missing servers array surfaced as a typed schema failure",
          };
        },
        timeout: async () => {
          provider.enqueueFault("GET", "/v1/servers", {
            type: "delay",
            durationMs: 100,
          });
          const timeoutClient = HetznerCloudClient.withTestTransport(
            "timeout-secret",
            {
              apiBaseUrl: `${provider.url}/v1`,
              requestTimeoutMs: 20,
            },
          );
          await expect(timeoutClient.listServers()).rejects.toMatchObject({
            code: "transport_error",
          });
          return {
            scenario: "timeout",
            status: "passed",
            detail: "adapter deadline aborted the real request",
          };
        },
        "connection-reset": async () => {
          const resetProvider = await startFakeProvider({
            fixtures: [
              {
                id: "reset-servers",
                method: "GET",
                path: "/v1/servers",
                response: { status: 200, body: { servers: [] } },
              },
            ],
          });
          const resetClient = HetznerCloudClient.withTestTransport(
            "reset-secret",
            {
              apiBaseUrl: `${resetProvider.url}/v1`,
              requestTimeoutMs: 20,
            },
          );
          await resetProvider.resetConnections();
          await expect(resetClient.listServers()).rejects.toMatchObject({
            code: "transport_error",
          });
          return {
            scenario: "connection-reset",
            status: "passed",
            detail:
              "stopped loopback upstream produced a typed transport failure",
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
          await client.listServers();
          const receipt = provider.receipts.find(
            (candidate) => candidate.operation === "hetzner.servers.list",
          );
          expect(receipt).toMatchObject({
            tenantId: "org-hetzner",
            accountId: "acct-hetzner",
            effectKind: "read",
            outcome: "succeeded",
            effect: { outcome: "applied" },
          });
          return {
            scenario: "read-policy",
            status: "passed",
            detail:
              "real list request completed under the provider read policy",
          };
        },
        "write-policy-receipt": async () => {
          const created = await client.createServer({
            name: "node-b",
            serverType: "cx22",
            location: "fsn1",
            image: "ubuntu",
            userData: "#!/bin/sh",
          });
          expect(created.server.id).toBe(8);
          const receipt = provider.receipts.find(
            (candidate) => candidate.operation === "hetzner.servers.create",
          );
          expect(receipt).toMatchObject({
            policy: {
              riskLevel: "R2",
              outcome: "allowed",
              confirmation: "already_granted",
            },
            providerResult: { status: "accepted", resultId: "8" },
            executedEffect: { performed: true },
            effect: { outcome: "applied" },
          });
          return {
            scenario: "write-policy-receipt",
            status: "passed",
            detail: "real create request completed and emitted a write receipt",
            receiptId: receipt?.id,
          };
        },
        "irreversible-policy-receipt": async () => {
          await client.deleteServer(7);
          const receipt = provider.receipts.find(
            (candidate) => candidate.operation === "hetzner.servers.delete",
          );
          expect(receipt).toMatchObject({
            effectKind: "irreversible",
            policy: {
              riskLevel: "R3",
              outcome: "allowed",
              confirmation: "already_granted",
            },
            executedEffect: { performed: true },
            effect: {
              outcome: "applied",
              commit: { kind: "provider_accepted" },
            },
          });
          return {
            scenario: "irreversible-policy-receipt",
            status: "passed",
            detail:
              "real delete request completed with an irreversible receipt",
            receiptId: receipt?.id,
          };
        },
      },
    });
    expect(report.observations).toHaveLength(15);
  });
});
