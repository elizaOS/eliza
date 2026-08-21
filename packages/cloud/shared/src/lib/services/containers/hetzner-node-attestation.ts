/**
 * Centralizes live Hetzner server authority checks for Cloud Docker nodes.
 * Capacity, health, and deletion transitions use this boundary so a database
 * row alone never authorizes a provider-backed node.
 */

import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { containersEnv } from "../../config/containers-env";
import type { ComputeProvider, ComputeServer } from "./compute-provider";
import { getComputeProvider } from "./compute-provider";
import { HetznerCloudError } from "./hetzner-cloud-api";

export interface HetznerServerAuthority {
  nodeId: string;
  environment: string;
  firewallIds: number[];
  serverId?: number;
}

export interface AttestedHetznerServer {
  server: ComputeServer;
  serverId: number;
}

export type HetznerFirewallAttestation = "applied" | "settling";

export function requireSafeHetznerServerId(value: number | string, context: string): number {
  const canonical = String(value);
  if (!/^[1-9]\d*$/.test(canonical)) {
    throw new HetznerCloudError(
      "invalid_input",
      `${context} does not have a canonical positive Hetzner server ID`,
    );
  }
  const serverId = Number(canonical);
  if (!Number.isSafeInteger(serverId) || serverId <= 0) {
    throw new HetznerCloudError(
      "invalid_input",
      `${context} has a provider server ID outside the safe Hetzner integer range`,
    );
  }
  return serverId;
}

function configuredFirewallIds(): number[] {
  let firewallIds: number[];
  try {
    firewallIds = containersEnv.defaultHcloudFirewallIds();
  } catch (error) {
    // error-policy:J2 Convert configuration parsing failures at the provider boundary.
    throw new HetznerCloudError(
      "invalid_input",
      error instanceof Error ? error.message : "Invalid Hetzner firewall configuration",
      undefined,
      error,
    );
  }
  if (firewallIds.length === 0) {
    throw new HetznerCloudError(
      "invalid_input",
      "CONTAINERS_HCLOUD_FIREWALL_IDS is required for Hetzner node authority",
    );
  }
  return firewallIds;
}

/** True only for the typed Cloud/Hetzner rows that carry provider authority. */
export function isTypedHetznerCloudNode(node: DockerNode): boolean {
  return node.fleet_kind === "cloud" && node.infrastructure_provider === "hetzner";
}

/** Resolve the exact provider identity and policy expected for a typed row. */
export function requireHetznerNodeAuthority(node: DockerNode): HetznerServerAuthority & {
  serverId: number;
} {
  if (!isTypedHetznerCloudNode(node) || node.provider_server_id === null) {
    throw new HetznerCloudError(
      "invalid_input",
      `Docker node ${node.node_id} has no canonical Hetzner Cloud identity`,
    );
  }
  const metadata = (node.metadata ?? {}) as Record<string, unknown>;
  const environment = containersEnv.environment();
  if (metadata.environment !== environment) {
    throw new HetznerCloudError(
      "invalid_input",
      `Docker node ${node.node_id} does not belong to the active environment`,
    );
  }
  return {
    nodeId: node.node_id,
    environment,
    firewallIds: configuredFirewallIds(),
    serverId: requireSafeHetznerServerId(node.provider_server_id, `Docker node ${node.node_id}`),
  };
}

/**
 * Validate one provider read model against an exact node, environment,
 * firewall policy, and optional requested server ID.
 */
export function assertAuthoritativeHetznerServer(
  server: ComputeServer,
  expected: HetznerServerAuthority,
  options: { allowSettling?: boolean } = {},
): HetznerFirewallAttestation {
  const returnedServerId = requireSafeHetznerServerId(
    server.id,
    `Hetzner server returned for ${expected.nodeId}`,
  );
  if (expected.serverId !== undefined && returnedServerId !== expected.serverId) {
    throw new HetznerCloudError(
      "invalid_input",
      `Hetzner returned server ${returnedServerId} for requested server ${expected.serverId}`,
    );
  }

  const labels = server.labels ?? {};
  if (
    labels["managed-by"] !== "eliza-cloud" ||
    labels["node-id"] !== expected.nodeId ||
    labels.environment !== expected.environment ||
    labels.tier !== "data-plane"
  ) {
    throw new HetznerCloudError(
      "invalid_input",
      `Hetzner server ${server.id} does not have the authoritative allocation labels`,
    );
  }

  const attachments = server.firewallAttachments ?? [];
  const actualIds = attachments.map((attachment) => Number(attachment.id));
  if (
    actualIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(actualIds).size !== actualIds.length ||
    attachments.some(
      (attachment) => attachment.status !== "applied" && attachment.status !== "pending",
    )
  ) {
    throw new HetznerCloudError(
      "invalid_input",
      `Hetzner server ${server.id} has ambiguous firewall attachment state`,
    );
  }

  const expectedIds = [...expected.firewallIds].sort((left, right) => left - right);
  const sortedActualIds = [...actualIds].sort((left, right) => left - right);
  const exactSet =
    sortedActualIds.length === expectedIds.length &&
    sortedActualIds.every((id, index) => id === expectedIds[index]);
  if (!exactSet) {
    if (options.allowSettling && attachments.length === 0) return "settling";
    throw new HetznerCloudError(
      "invalid_input",
      `Hetzner server ${server.id} does not have the exact configured firewall set`,
    );
  }
  if (attachments.some((attachment) => attachment.status === "pending")) {
    if (options.allowSettling) return "settling";
    throw new HetznerCloudError(
      "invalid_input",
      `Hetzner server ${server.id} firewall attachment has not settled`,
    );
  }
  return "applied";
}

/** Read and attest the exact provider object named by a typed Docker node. */
export async function attestHetznerCloudNode(
  node: DockerNode,
  provider: ComputeProvider = getComputeProvider(),
): Promise<AttestedHetznerServer> {
  const expected = requireHetznerNodeAuthority(node);
  const server = await provider.getServer(expected.serverId);
  if (!server) {
    throw new HetznerCloudError(
      "not_found",
      `Hetzner server ${expected.serverId} for node ${node.node_id} is absent`,
    );
  }
  assertAuthoritativeHetznerServer(server, expected);
  return { server, serverId: expected.serverId };
}
