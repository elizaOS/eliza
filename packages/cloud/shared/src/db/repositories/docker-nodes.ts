/**
 * Persists Docker node records for cloud scheduling and control-plane health.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "../../lib/utils/logger";
import { dbRead, dbWrite } from "../helpers";
import {
  type DockerNode,
  type DockerNodeFleetKind,
  type DockerNodeInfrastructureProvider,
  type DockerNodeStatus,
  dockerNodes,
  type NewDockerNode,
  PLACEABLE_NODE_STATE,
} from "../schemas/docker-nodes";
import {
  AgentBackupSourceAuthorityError,
  requireCanonicalNodeIncarnation,
} from "./agent-backup-source-authority";

export type {
  DockerNode,
  DockerNodeFleetKind,
  DockerNodeInfrastructureProvider,
  DockerNodeStatus,
  NewDockerNode,
};

export interface NodeIncarnationCasInput {
  id: string;
  nodeId: string;
  expectedIncarnation: string | null;
}

export interface NodeHostKeyFingerprintCasInput {
  id: string;
  nodeId: string;
  expectedFingerprint: string | null;
  observedFingerprint: string | null;
}

export interface RobotSourceAuthorityRegistration {
  hostname: string;
  sshPort: number;
  sshUser: string;
  capacity: number;
  status: DockerNodeStatus;
  hostKeyFingerprint: string;
  metadata: Record<string, unknown>;
}

const DOCKER_NODE_IDENTITY_FIELDS = [
  "id",
  "node_id",
  "node_incarnation",
  "fleet_kind",
  "infrastructure_provider",
  "provider_server_id",
  "host_key_fingerprint",
] as const;

type DockerNodeIdentityField = (typeof DOCKER_NODE_IDENTITY_FIELDS)[number];
export type DockerNodeMutableUpdate = Partial<Omit<NewDockerNode, DockerNodeIdentityField>>;

function rejectDockerNodeIdentityMutation(data: DockerNodeMutableUpdate): void {
  for (const field of DOCKER_NODE_IDENTITY_FIELDS) {
    if (Object.hasOwn(data, field)) {
      throw new AgentBackupSourceAuthorityError(
        `Generic Docker node update cannot mutate identity field '${field}'`,
      );
    }
  }
}

function requireExpectedIncarnation(value: string | null): string | null {
  return value === null ? null : requireCanonicalNodeIncarnation(value);
}

function requireHostKeyFingerprint(value: string): string {
  if (!value.trim()) {
    throw new AgentBackupSourceAuthorityError("Node host-key fingerprint must not be empty");
  }
  return value;
}

function canonicalizeHostKeyFingerprint(value: string): string {
  return requireHostKeyFingerprint(value).trim();
}

function nodeIncarnationCasPredicate(expectedIncarnation: string | null) {
  return sql`${dockerNodes.node_incarnation} IS NOT DISTINCT FROM ${expectedIncarnation}`;
}

function hostKeyFingerprintCasPredicate(expectedFingerprint: string | null) {
  return sql`${dockerNodes.host_key_fingerprint} IS NOT DISTINCT FROM ${expectedFingerprint}`;
}

function typedSourceAuthorityPredicate() {
  return sql`${dockerNodes.infrastructure_provider} = 'hetzner'
    AND ${dockerNodes.host_key_fingerprint} IS NOT NULL
    AND btrim(${dockerNodes.host_key_fingerprint}) <> ''
    AND (
      (${dockerNodes.fleet_kind} = 'robot' AND ${dockerNodes.provider_server_id} IS NULL)
      OR (${dockerNodes.fleet_kind} = 'cloud'
        AND CASE
          WHEN ${dockerNodes.provider_server_id} ~ '^[1-9][0-9]{0,19}$'
            THEN ${dockerNodes.provider_server_id}::numeric <= 18446744073709551615
          ELSE false
        END)
    )`;
}

async function findDockerNodeByIdOnPrimary(id: string): Promise<DockerNode | null> {
  const [node] = await dbWrite.select().from(dockerNodes).where(eq(dockerNodes.id, id)).limit(1);
  return node ?? null;
}

function currentDeploymentEnvironment(): string | null {
  const env = typeof process !== "undefined" ? process.env.ENVIRONMENT?.trim() : undefined;
  return env ? env : null;
}

export function stampDockerNodeEnvironmentMetadata(
  metadata: Record<string, unknown> | null | undefined,
  environment: string | null = currentDeploymentEnvironment(),
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  const existing = base.environment;
  if (!environment || (typeof existing === "string" && existing.trim().length > 0)) {
    return base;
  }
  return { ...base, environment };
}

/**
 * Environment guard for node reads, split by consequence.
 *
 * `placement` fails CLOSED: with ENVIRONMENT set, only rows explicitly stamped
 * with the same environment are eligible. An unlabeled row must never receive
 * a placement — treating '' as "matches everything" is how a staging box
 * registered in the production DB became a production placement target
 * (elizaOS/eliza#22547), and deleting such a row leaves the gate open for the
 * next one. Live fleets must therefore carry `metadata.environment`; the
 * onboarding, bootstrap-callback, and admin-register paths all stamp it via
 * {@link stampDockerNodeEnvironmentMetadata}.
 *
 * `operational` stays inclusive of unlabeled rows so health checks, disk
 * monitoring, and the orphan reconciler keep watching legacy nodes, while
 * still excluding rows stamped for a DIFFERENT environment.
 */
function currentEnvironmentPredicate(scope: "placement" | "operational") {
  const environment = currentDeploymentEnvironment();
  if (!environment) return sql`TRUE`;
  if (scope === "placement") {
    return sql`${dockerNodes.metadata}->>'environment' = ${environment}`;
  }
  return sql`(
    COALESCE(${dockerNodes.metadata}->>'environment', '') = ''
    OR ${dockerNodes.metadata}->>'environment' = ${environment}
  )`;
}

/** Provisional autoscaler capacity must never count as schedulable authority. */
function capacityAttestedPredicate() {
  return sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`;
}

export class DockerNodesRepository {
  // ============================================================================
  // READ OPERATIONS
  // ============================================================================

  async findAll(): Promise<DockerNode[]> {
    return dbRead.select().from(dockerNodes).orderBy(asc(dockerNodes.node_id));
  }

  /**
   * Every operationally live node, INCLUDING cordoned ones.
   *
   * This is the operational set, not the placement set: health checks,
   * allocated-count sync, disk monitoring, image pre-pull, and the orphan
   * reconciler all read it, and every one of them must keep watching a node
   * that is being emptied — that is exactly when its residents move, fail, or
   * strand a container. Use {@link findPlaceable} to pick a home for new work.
   */
  async findEnabled(): Promise<DockerNode[]> {
    return dbRead
      .select()
      .from(dockerNodes)
      .where(and(eq(dockerNodes.enabled, true), currentEnvironmentPredicate("operational")))
      .orderBy(asc(dockerNodes.node_id));
  }

  /**
   * Nodes that may receive NEW placements: enabled and not cordoned.
   *
   * Kept separate from {@link findEnabled} rather than added as a flag,
   * because the two sets diverge exactly when it matters and a boolean
   * argument makes the wrong one a typo away.
   */
  async findPlaceable(): Promise<DockerNode[]> {
    return dbRead
      .select()
      .from(dockerNodes)
      .where(
        and(
          eq(dockerNodes.enabled, true),
          eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
          capacityAttestedPredicate(),
          currentEnvironmentPredicate("placement"),
        ),
      )
      .orderBy(asc(dockerNodes.node_id));
  }

  async findByNodeId(nodeId: string): Promise<DockerNode | null> {
    const [r] = await dbRead
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, nodeId))
      .limit(1);
    return r ?? null;
  }

  async findById(id: string): Promise<DockerNode | null> {
    const [r] = await dbRead.select().from(dockerNodes).where(eq(dockerNodes.id, id)).limit(1);
    return r ?? null;
  }

  /**
   * Find the least-loaded node that is enabled, healthy, and has available capacity.
   * Orders by (capacity - allocated_count) descending, picks the one with most room.
   */
  async findLeastLoaded(): Promise<DockerNode | null> {
    const [r] = await dbRead
      .select()
      .from(dockerNodes)
      .where(
        and(
          eq(dockerNodes.enabled, true),
          eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
          eq(dockerNodes.status, "healthy"),
          capacityAttestedPredicate(),
          currentEnvironmentPredicate("placement"),
          sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
        ),
      )
      .orderBy(sql`(${dockerNodes.capacity} - ${dockerNodes.allocated_count}) DESC`)
      .limit(1);
    return r ?? null;
  }

  // ============================================================================
  // WRITE OPERATIONS
  // ============================================================================

  async create(data: NewDockerNode): Promise<DockerNode> {
    const [r] = await dbWrite.insert(dockerNodes).values(data).returning();
    if (!r) throw new Error("Failed to create docker node record");
    return r;
  }

  async update(id: string, data: DockerNodeMutableUpdate): Promise<DockerNode | null> {
    rejectDockerNodeIdentityMutation(data);
    const [r] = await dbWrite
      .update(dockerNodes)
      .set({ ...data, updated_at: new Date() })
      .where(eq(dockerNodes.id, id))
      .returning();
    return r ?? null;
  }

  /**
   * Rotate a typed node's exact Linux boot UUID with compare-and-swap fencing.
   * Same-boot replay is idempotent; a stale expected UUID can never roll back
   * a newer attestation.
   */
  async attestNodeIncarnation(
    input: NodeIncarnationCasInput & {
      expectedHostKeyFingerprint: string;
      observedIncarnation: string;
    },
  ): Promise<DockerNode> {
    const expected = requireExpectedIncarnation(input.expectedIncarnation);
    const expectedHostKeyFingerprint = requireHostKeyFingerprint(input.expectedHostKeyFingerprint);
    const observed = requireCanonicalNodeIncarnation(input.observedIncarnation);
    const [updated] = await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: observed, updated_at: new Date() })
      .where(
        and(
          eq(dockerNodes.id, input.id),
          eq(dockerNodes.node_id, input.nodeId),
          nodeIncarnationCasPredicate(expected),
          hostKeyFingerprintCasPredicate(expectedHostKeyFingerprint),
          typedSourceAuthorityPredicate(),
        ),
      )
      .returning();
    if (updated) return updated;

    const current = await findDockerNodeByIdOnPrimary(input.id);
    if (
      current?.node_id === input.nodeId &&
      current.host_key_fingerprint === expectedHostKeyFingerprint &&
      current.node_incarnation === observed
    ) {
      return current;
    }
    throw new AgentBackupSourceAuthorityError(
      "Node incarnation attestation lost its compare-and-swap authority",
    );
  }

  /** Fail closed after a typed node's boot-id probe becomes unavailable. */
  async invalidateNodeIncarnation(
    input: NodeIncarnationCasInput & { expectedHostKeyFingerprint: string | null },
  ): Promise<DockerNode> {
    const expected = requireExpectedIncarnation(input.expectedIncarnation);
    const expectedHostKeyFingerprint =
      input.expectedHostKeyFingerprint === null
        ? null
        : requireHostKeyFingerprint(input.expectedHostKeyFingerprint);
    const [updated] = await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: null, updated_at: new Date() })
      .where(
        and(
          eq(dockerNodes.id, input.id),
          eq(dockerNodes.node_id, input.nodeId),
          nodeIncarnationCasPredicate(expected),
          hostKeyFingerprintCasPredicate(expectedHostKeyFingerprint),
          typedSourceAuthorityPredicate(),
        ),
      )
      .returning();
    if (updated) return updated;

    const current = await findDockerNodeByIdOnPrimary(input.id);
    if (
      current?.node_id === input.nodeId &&
      current.host_key_fingerprint === expectedHostKeyFingerprint &&
      current.node_incarnation === null
    ) {
      return current;
    }
    throw new AgentBackupSourceAuthorityError(
      "Node incarnation invalidation lost its compare-and-swap authority",
    );
  }

  /**
   * Establish or rotate the SSH host-key pin under compare-and-swap fencing.
   * Any pin write invalidates the boot UUID in the same statement, so capture
   * stays ineligible until that exact key verifies a fresh boot attestation.
   */
  async rotateNodeHostKeyFingerprint(input: NodeHostKeyFingerprintCasInput): Promise<DockerNode> {
    const expectedFingerprint =
      input.expectedFingerprint === null
        ? null
        : requireHostKeyFingerprint(input.expectedFingerprint);
    const observedFingerprint =
      input.observedFingerprint === null
        ? null
        : canonicalizeHostKeyFingerprint(input.observedFingerprint);
    const [updated] = await dbWrite
      .update(dockerNodes)
      .set({
        host_key_fingerprint: observedFingerprint,
        node_incarnation: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(dockerNodes.id, input.id),
          eq(dockerNodes.node_id, input.nodeId),
          hostKeyFingerprintCasPredicate(expectedFingerprint),
        ),
      )
      .returning();
    if (updated) return updated;

    const current = await findDockerNodeByIdOnPrimary(input.id);
    if (
      current?.node_id === input.nodeId &&
      current.host_key_fingerprint === observedFingerprint &&
      current.node_incarnation === null
    ) {
      return current;
    }
    throw new AgentBackupSourceAuthorityError(
      "Node host-key rotation lost its compare-and-swap authority",
    );
  }

  /**
   * Explicit Robot onboarding may establish authority for an all-null legacy
   * row, but never reinterpret a typed Cloud row or metadata projection.
   */
  async attestRobotSourceAuthority(
    input: NodeIncarnationCasInput & {
      expectedHostKeyFingerprint: string | null;
      observedIncarnation: string;
      registration: RobotSourceAuthorityRegistration;
    },
  ): Promise<DockerNode> {
    const expected = requireExpectedIncarnation(input.expectedIncarnation);
    const expectedHostKeyFingerprint =
      input.expectedHostKeyFingerprint === null
        ? null
        : requireHostKeyFingerprint(input.expectedHostKeyFingerprint);
    const observed = requireCanonicalNodeIncarnation(input.observedIncarnation);
    const hostKeyFingerprint = canonicalizeHostKeyFingerprint(
      input.registration.hostKeyFingerprint,
    );
    const [updated] = await dbWrite
      .update(dockerNodes)
      .set({
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        provider_server_id: null,
        node_incarnation: observed,
        hostname: input.registration.hostname,
        ssh_port: input.registration.sshPort,
        ssh_user: input.registration.sshUser,
        capacity: input.registration.capacity,
        status: input.registration.status,
        host_key_fingerprint: hostKeyFingerprint,
        metadata: input.registration.metadata,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(dockerNodes.id, input.id),
          eq(dockerNodes.node_id, input.nodeId),
          nodeIncarnationCasPredicate(expected),
          hostKeyFingerprintCasPredicate(expectedHostKeyFingerprint),
          sql`(
            (${dockerNodes.fleet_kind} IS NULL
              AND ${dockerNodes.infrastructure_provider} IS NULL
              AND ${dockerNodes.provider_server_id} IS NULL)
            OR (${dockerNodes.fleet_kind} = 'robot'
              AND ${dockerNodes.infrastructure_provider} = 'hetzner'
              AND ${dockerNodes.provider_server_id} IS NULL)
          )`,
        ),
      )
      .returning();
    if (updated) return updated;

    const current = await findDockerNodeByIdOnPrimary(input.id);
    if (
      current?.node_id === input.nodeId &&
      current.fleet_kind === "robot" &&
      current.infrastructure_provider === "hetzner" &&
      current.provider_server_id === null &&
      current.host_key_fingerprint === hostKeyFingerprint &&
      current.node_incarnation === observed
    ) {
      return current;
    }
    throw new AgentBackupSourceAuthorityError(
      "Robot source-authority attestation conflicts with a newer or Cloud registration",
    );
  }

  /**
   * Replace an autoscaler's provisional capacity with its first hardware
   * attestation. The metadata predicate is the exactly-once fence: concurrent
   * or later callbacks cannot consume the marker twice or overwrite a tune.
   */
  async reconcileProvisionalCapacity(
    id: string,
    data: {
      capacity: number;
      hostname: string;
      ssh_port: number;
      ssh_user: string;
      status: DockerNodeStatus;
    },
    metadataPatch: Record<string, unknown>,
  ): Promise<DockerNode | null> {
    const patch = JSON.stringify(metadataPatch);
    const [r] = await dbWrite
      .update(dockerNodes)
      .set({
        ...data,
        metadata: sql`(${dockerNodes.metadata} - 'capacityProvisional') || ${patch}::jsonb`,
        updated_at: new Date(),
      })
      .where(
        and(eq(dockerNodes.id, id), sql`${dockerNodes.metadata}->>'capacityProvisional' = 'true'`),
      )
      .returning();
    return r ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const r = await dbWrite
      .delete(dockerNodes)
      .where(eq(dockerNodes.id, id))
      .returning({ id: dockerNodes.id });
    return r.length > 0;
  }

  async updateStatus(nodeId: string, status: DockerNodeStatus): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        status,
        last_health_check: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  /**
   * Mark a node offline AND disable it in one write — used when consecutive
   * health checks confirm it is dead, to route it out of scheduling (`enabled`
   * gates `findEnabled`) while recording why (`status=offline`). An operator
   * re-enables it after remediation.
   */
  async markOfflineAndDisable(nodeId: string): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        status: "offline",
        enabled: false,
        last_health_check: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  async incrementAllocated(nodeId: string): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} + 1`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  async decrementAllocated(nodeId: string): Promise<void> {
    const [result] = await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId))
      .returning({ allocated_count: dockerNodes.allocated_count });

    // If allocated_count is 0 after GREATEST clamping, the count was already
    // at 0 before decrement — likely a sync issue worth investigating.
    if (result && result.allocated_count === 0) {
      logger.warn(
        `[docker-nodes] decrementAllocated clamped to 0 for node ${nodeId} — allocation count may be out of sync`,
      );
    }
  }

  /**
   * Persist the health loop's local-embedding-sidecar verdict into the node's
   * metadata (`metadata.embeddingSidecar = { status, checkedAt }`). A jsonb
   * merge so concurrent writers of other metadata keys (environment stamp,
   * onboard provenance) are never clobbered by the health cycle.
   */
  async setEmbeddingSidecarHealth(
    nodeId: string,
    status: "running" | "unresponsive" | "missing",
  ): Promise<void> {
    const patch = JSON.stringify({
      embeddingSidecar: { status, checkedAt: new Date().toISOString() },
    });
    await dbWrite
      .update(dockerNodes)
      .set({
        metadata: sql`${dockerNodes.metadata} || ${patch}::jsonb`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  /**
   * Set allocated_count to an exact value (used during sync).
   */
  async setAllocatedCount(nodeId: string, count: number): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: count,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }
}

export const dockerNodesRepository = new DockerNodesRepository();
