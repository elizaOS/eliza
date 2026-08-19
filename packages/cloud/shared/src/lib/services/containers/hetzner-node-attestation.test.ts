/** Exercises live Hetzner node authority with deterministic provider read models. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import type { ComputeProvider, ComputeServer } from "./compute-provider";
import {
  assertAuthoritativeHetznerServer,
  attestHetznerCloudNode,
} from "./hetzner-node-attestation";

const FIREWALL_ENV = "CONTAINERS_HCLOUD_FIREWALL_IDS";
const ENVIRONMENT_ENV = "ENVIRONMENT";
let originalFirewallIds: string | undefined;
let originalEnvironment: string | undefined;

function node(): DockerNode {
  return {
    id: "row-1",
    node_id: "node-1",
    hostname: "203.0.113.1",
    ssh_port: 22,
    ssh_user: "root",
    capacity: 8,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    host_key_fingerprint: "SHA256:test",
    fleet_kind: "cloud",
    infrastructure_provider: "hetzner",
    provider_server_id: "4242",
    node_incarnation: null,
    metadata: { environment: "staging", provider: "hetzner-cloud" },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function server(overrides: Partial<ComputeServer> = {}): ComputeServer {
  return {
    id: 4242,
    name: "node-1",
    status: "running",
    labels: {
      "managed-by": "eliza-cloud",
      "node-id": "node-1",
      environment: "staging",
      tier: "data-plane",
    },
    firewallAttachments: [
      { id: 8101, status: "applied" },
      { id: 8102, status: "applied" },
    ],
    ...overrides,
  };
}

function provider(read: ComputeServer | null): ComputeProvider {
  return {
    getServer: async () => read,
  } as unknown as ComputeProvider;
}

beforeEach(() => {
  originalFirewallIds = process.env[FIREWALL_ENV];
  originalEnvironment = process.env[ENVIRONMENT_ENV];
  process.env[FIREWALL_ENV] = "8101,8102";
  process.env[ENVIRONMENT_ENV] = "staging";
});

afterEach(() => {
  if (originalFirewallIds === undefined) delete process.env[FIREWALL_ENV];
  else process.env[FIREWALL_ENV] = originalFirewallIds;
  if (originalEnvironment === undefined) delete process.env[ENVIRONMENT_ENV];
  else process.env[ENVIRONMENT_ENV] = originalEnvironment;
});

describe("Hetzner node authority", () => {
  test("accepts only the exact typed row, provider ID, labels, and applied firewall set", async () => {
    await expect(attestHetznerCloudNode(node(), provider(server()))).resolves.toMatchObject({
      serverId: 4242,
    });
  });

  test("rejects a different server returned for the requested provider ID", async () => {
    await expect(attestHetznerCloudNode(node(), provider(server({ id: 9999 })))).rejects.toThrow(
      "returned server 9999 for requested server 4242",
    );
  });

  test("rejects label drift and never treats it as current allocation authority", async () => {
    await expect(
      attestHetznerCloudNode(
        node(),
        provider(
          server({
            labels: {
              "managed-by": "eliza-cloud",
              "node-id": "node-1",
              environment: "production",
              tier: "data-plane",
            },
          }),
        ),
      ),
    ).rejects.toThrow("authoritative allocation labels");
  });

  test("rejects an ambiguous or incomplete firewall attachment state", async () => {
    for (const firewallAttachments of [
      [{ id: 8101, status: "applied" }],
      [
        { id: 8101, status: "applied" },
        { id: 8102, status: "pending" },
      ],
      [{ id: 8101 }, { id: 8102, status: "applied" }],
    ]) {
      await expect(
        attestHetznerCloudNode(node(), provider(server({ firewallAttachments }))),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  test("exposes pending only to the bounded create-settlement caller", () => {
    expect(
      assertAuthoritativeHetznerServer(
        server({
          firewallAttachments: [
            { id: 8101, status: "applied" },
            { id: 8102, status: "pending" },
          ],
        }),
        {
          nodeId: "node-1",
          environment: "staging",
          firewallIds: [8101, 8102],
          serverId: 4242,
        },
        { allowSettling: true },
      ),
    ).toBe("settling");
  });
});
