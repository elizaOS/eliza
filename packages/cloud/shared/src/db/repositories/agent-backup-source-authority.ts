/** Exact, fail-closed Robot/Cloud authority used by backup manifest v2. */

import type { AgentBackupManifestV2Source } from "@elizaos/shared";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import { dockerNodes } from "../schemas/docker-nodes";

const LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOCKER_ID_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_SERVER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export class AgentBackupSourceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBackupSourceAuthorityError";
  }
}

export function requireCanonicalNodeIncarnation(value: string): string {
  if (!LOWERCASE_UUID_PATTERN.test(value)) {
    throw new AgentBackupSourceAuthorityError("nodeIncarnation must be an exact lowercase UUID");
  }
  return value;
}

/** Parse one exact Linux `/proc/sys/kernel/random/boot_id` response. */
export function parseLinuxBootId(output: string): string {
  return requireCanonicalNodeIncarnation(output.trim());
}

export function requireCanonicalProviderServerId(value: string): string {
  if (!PROVIDER_SERVER_ID_PATTERN.test(value) || BigInt(value) > UINT64_MAX) {
    throw new AgentBackupSourceAuthorityError(
      "providerServerId must be a canonical positive uint64 decimal",
    );
  }
  return value;
}

function requireNodeRecordId(value: string): string {
  if (!LOWERCASE_UUID_PATTERN.test(value)) {
    throw new AgentBackupSourceAuthorityError("nodeRecordId must be a lowercase UUID");
  }
  return value;
}

function requireNodeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new AgentBackupSourceAuthorityError("nodeId must be a canonical node handle");
  }
  return value;
}

function requireContainerId(value: string): string {
  if (!DOCKER_ID_PATTERN.test(value)) {
    throw new AgentBackupSourceAuthorityError(
      "containerId must be an exact lowercase 64-character Docker ID",
    );
  }
  return value;
}

export interface AgentBackupManifestSourceAuthorityLocator {
  nodeRecordId: string;
  nodeId: string;
  nodeIncarnation: string;
  containerId: string;
}

export interface AgentBackupManifestSourceOccurrenceAuthority {
  source: AgentBackupManifestV2Source;
  /** Append-only token; node incarnation UUIDs are reusable after ABA. */
  nodeHistoryId: string;
}

function validateLocator(
  input: AgentBackupManifestSourceAuthorityLocator,
): AgentBackupManifestSourceAuthorityLocator {
  return {
    nodeRecordId: requireNodeRecordId(input.nodeRecordId),
    nodeId: requireNodeId(input.nodeId),
    nodeIncarnation: requireCanonicalNodeIncarnation(input.nodeIncarnation),
    containerId: requireContainerId(input.containerId),
  };
}

/**
 * Resolve exact source identity inside a caller-owned primary transaction.
 * The no-key-update lock prevents re-registration/reboot authority from
 * changing until the caller has durably snapshotted the returned vector.
 */
export async function resolveAgentBackupManifestSourceOccurrenceAuthorityInTransaction(
  tx: DbTransaction,
  input: AgentBackupManifestSourceAuthorityLocator,
): Promise<AgentBackupManifestSourceOccurrenceAuthority> {
  const locator = validateLocator(input);
  const [node] = await tx
    .select({
      nodeRecordId: dockerNodes.id,
      nodeId: dockerNodes.node_id,
      fleetKind: dockerNodes.fleet_kind,
      infrastructureProvider: dockerNodes.infrastructure_provider,
      providerServerId: dockerNodes.provider_server_id,
      nodeIncarnation: dockerNodes.node_incarnation,
      nodeHistoryId: dockerNodes.current_node_history_id,
      hostKeyFingerprint: dockerNodes.host_key_fingerprint,
    })
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.id, locator.nodeRecordId),
        eq(dockerNodes.node_id, locator.nodeId),
        eq(dockerNodes.node_incarnation, locator.nodeIncarnation),
      ),
    )
    .for("no key update")
    .limit(1);

  if (
    !node ||
    node.infrastructureProvider !== "hetzner" ||
    node.nodeIncarnation !== locator.nodeIncarnation ||
    !node.nodeHistoryId ||
    !node.hostKeyFingerprint?.trim()
  ) {
    throw new AgentBackupSourceAuthorityError(
      "Backup source node is legacy, unattested, stale, or no longer matches",
    );
  }

  const base = {
    provider: "hetzner" as const,
    nodeRecordId: node.nodeRecordId,
    nodeIncarnation: node.nodeIncarnation,
    nodeId: node.nodeId,
    containerId: locator.containerId,
  };
  if (node.fleetKind === "robot" && node.providerServerId === null) {
    return Object.freeze({
      source: Object.freeze({ kind: "robot" as const, ...base }),
      nodeHistoryId: node.nodeHistoryId,
    });
  }
  if (node.fleetKind === "cloud" && node.providerServerId !== null) {
    return Object.freeze({
      source: Object.freeze({
        kind: "cloud" as const,
        ...base,
        providerServerId: requireCanonicalProviderServerId(node.providerServerId),
      }),
      nodeHistoryId: node.nodeHistoryId,
    });
  }
  throw new AgentBackupSourceAuthorityError(
    "Backup source node has an incomplete or contradictory Robot/Cloud authority",
  );
}

export async function resolveAgentBackupManifestSourceAuthorityInTransaction(
  tx: DbTransaction,
  input: AgentBackupManifestSourceAuthorityLocator,
): Promise<AgentBackupManifestV2Source> {
  return (await resolveAgentBackupManifestSourceOccurrenceAuthorityInTransaction(tx, input)).source;
}

/** Resolve against the primary, never a replica or JSON metadata projection. */
export async function resolveAgentBackupManifestSourceAuthority(
  input: AgentBackupManifestSourceAuthorityLocator,
): Promise<AgentBackupManifestV2Source> {
  return dbWrite.transaction((tx) =>
    resolveAgentBackupManifestSourceAuthorityInTransaction(tx, input),
  );
}
