// Persists agent sandboxes records for cloud services through the shared DB boundary.
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql } from "drizzle-orm";
import {
  applyBackupDelta,
  type BackupChainNode,
  requireBackupDelta,
  requireBackupStateData,
  resolveBackupChain,
  selectPrunableBackupIds,
} from "../../lib/services/agent-backup-diff";
import { AGENT_MANAGED_DISCORD_KEY } from "../../lib/services/eliza-agent-config";
import { ObjectNamespaces } from "../../lib/storage/object-namespace";
import { getObjectText, offloadJsonField } from "../../lib/storage/object-store";
import { decryptAgentBackupStateData, encryptAgentBackupStateData } from "../crypto/agent-backups";
import { ensureAgentSandboxSchema } from "../ensure-agent-sandbox-schema";
import { sqlRows } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import {
  type AgentBackupSnapshotType,
  type AgentBackupStateData,
  type AgentBackupStoredStateData,
  type AgentSandbox,
  type AgentSandboxBackup,
  type AgentSandboxStatus,
  agentSandboxBackups,
  agentSandboxes,
  type NewAgentSandbox,
  type NewAgentSandboxBackup,
  type StoredAgentSandboxBackup,
  WARM_POOL_ORG_ID,
  WARM_POOL_USER_ID,
} from "../schemas/agent-sandboxes";
import { jobs } from "../schemas/jobs";

export type {
  AgentBackupSnapshotType,
  AgentSandbox,
  AgentSandboxBackup,
  AgentSandboxStatus,
  NewAgentSandbox,
  NewAgentSandboxBackup,
};

export type AgentSandboxBackupMetadata = Omit<StoredAgentSandboxBackup, "state_data">;

const EMPTY_BACKUP_STATE: AgentSandboxBackup["state_data"] = {
  memories: [],
  config: {},
  workspaceFiles: {},
};

async function backupOrganizationId(sandboxRecordId: string): Promise<string> {
  const [sandbox] = await dbWrite
    .select({ organizationId: agentSandboxes.organization_id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, sandboxRecordId))
    .limit(1);
  if (!sandbox) throw new Error(`Agent sandbox not found: ${sandboxRecordId}`);
  return sandbox.organizationId;
}

export async function hydrateAgentSandboxBackup(
  backup: StoredAgentSandboxBackup,
): Promise<AgentSandboxBackup> {
  let stateData = backup.state_data;
  if (backup.state_data_storage === "r2") {
    if (!backup.state_data_key) {
      throw new Error(`Agent sandbox backup ${backup.id} is missing state_data_key`);
    }

    const raw = await getObjectText(backup.state_data_key);
    if (!raw) {
      throw new Error(`Agent sandbox backup payload not found: ${backup.state_data_key}`);
    }

    stateData = JSON.parse(raw) as AgentBackupStoredStateData;
  }

  const decrypted = await decryptAgentBackupStateData(backup.id, stateData);

  return {
    ...backup,
    state_data: decrypted,
  };
}

export async function prepareAgentBackupInsertData(
  data: NewAgentSandboxBackup,
  organizationId?: string,
): Promise<NewAgentSandboxBackup> {
  if (data.state_data_storage === "r2") return data;

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const effectiveOrganizationId =
    organizationId ?? (await backupOrganizationId(data.sandbox_record_id));
  const encryptedStateData = await encryptAgentBackupStateData(
    effectiveOrganizationId,
    id,
    data.state_data,
  );
  const stateData = await offloadJsonField<AgentBackupStoredStateData>({
    namespace: ObjectNamespaces.AgentSandboxBackups,
    organizationId: effectiveOrganizationId,
    objectId: id,
    field: "state_data",
    createdAt,
    value: encryptedStateData,
    inlineValueWhenOffloaded: EMPTY_BACKUP_STATE,
  });

  return {
    ...data,
    id,
    created_at: createdAt,
    state_data: stateData.value ?? EMPTY_BACKUP_STATE,
    state_data_storage: stateData.storage,
    state_data_key: stateData.key,
  };
}

export class AgentSandboxesRepository {
  // Reads

  async findById(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, id))
      .limit(1);
    return r;
  }

  async findOrganizationIdById(id: string): Promise<string | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select({ organizationId: agentSandboxes.organization_id })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, id))
      .limit(1);
    return r?.organizationId;
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async findByIdAndOrgForWrite(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async listByOrganization(orgId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.organization_id, orgId))
      .orderBy(desc(agentSandboxes.created_at));
  }

  async findBySandboxId(sandboxId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.sandbox_id, sandboxId))
      .limit(1);
    return r;
  }

  async findLatestByCharacterId(characterId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.character_id, characterId))
      .orderBy(desc(agentSandboxes.updated_at))
      .limit(1);
    return r;
  }

  /** List active (non-terminal) sandboxes on a specific docker node. */
  async listByNodeId(nodeId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const terminalStatuses: AgentSandboxStatus[] = ["stopped", "error"];
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.node_id, nodeId),
          notInArray(agentSandboxes.status, terminalStatuses),
        ),
      );
  }

  /**
   * Running sandboxes the heartbeat cycle should dial. Excludes the `shared`
   * execution tier: those run container-free in the hosted shared runtime
   * (node_id / container_name are NULL by design), so there is nothing to
   * dial over the Headscale tunnel — heartbeating them only ever fails and
   * spams the logs. Only dedicated/custom tiers have a real container.
   */
  async listRunning(): Promise<Array<{ id: string; organization_id: string }>> {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.status, "running"), ne(agentSandboxes.execution_tier, "shared")),
      );
  }

  /**
   * `disconnected` always-on (paid) agents that should be reconciled back to
   * `running`. A `dedicated-always` agent is contractually meant to stay up, so
   * a transient tailnet drop that flipped it to `disconnected` must self-heal —
   * the recovery cycle re-probes the bridge and either flips it back to
   * `running` (still reachable) or re-provisions it (truly down). Scoped to
   * `dedicated-always` because `dedicated-lazy`/`shared` are NOT meant to hold
   * an always-on container. Deleted rows are excluded.
   */
  async listRecoverable(limit = 100): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      bridge_url: string | null;
      updated_at: Date;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        bridge_url: agentSandboxes.bridge_url,
        updated_at: agentSandboxes.updated_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "disconnected"),
          eq(agentSandboxes.execution_tier, "dedicated-always"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .limit(limit);
  }

  /**
   * Shared-tier bridge rows old enough to be reap candidates: live (not
   * soft-deleted), `execution_tier = 'shared'`, created before `cutoff`. The
   * shared→dedicated handoff deletes the bridge on success; a timed-out/failed
   * handoff (or a closed browser) leaks the row. Oldest first so a backlog
   * drains deterministically under the per-tick cap. The orphan decision is NOT
   * made here — the caller pairs these against live dedicated twins (#9939).
   */
  async listSharedBridgeReapCandidates(
    cutoff: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      created_at: Date;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.execution_tier, "shared"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          lt(agentSandboxes.created_at, cutoff),
        ),
      )
      .orderBy(asc(agentSandboxes.created_at))
      .limit(limit);
  }

  /**
   * Live (running, non-deleted) dedicated sandboxes in the given orgs — the
   * "twin took over" side of the orphan-shared decision. A shared bridge is an
   * orphan only when one of these shares its (org, user, agent_name) and was
   * created at/after it (the handoff mints the bridge first, then the dedicated
   * twin). Scoped to the candidate orgs to keep the scan bounded (#9939).
   */
  async listLiveDedicatedTwins(organizationIds: string[]): Promise<
    Array<{
      organization_id: string;
      user_id: string;
      agent_name: string | null;
      created_at: Date;
    }>
  > {
    if (organizationIds.length === 0) return [];
    return dbRead
      .select({
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        agent_name: agentSandboxes.agent_name,
        created_at: agentSandboxes.created_at,
      })
      .from(agentSandboxes)
      .where(
        and(
          inArray(agentSandboxes.organization_id, organizationIds),
          eq(agentSandboxes.status, "running"),
          ne(agentSandboxes.execution_tier, "shared"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      );
  }

  /**
   * Find running, non-deleted agents whose stored `image_digest` differs
   * from `targetDigest` (treating NULL as different). Used by the
   * fleet-upgrade reconciler to enqueue blue/green swaps onto the
   * currently-deployed image. Capped by `limit` so a single cycle doesn't
   * try to enqueue the whole fleet at once.
   */
  async listRunningWithDigestOtherThan(
    targetDigest: string,
    targetImage: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      image_digest: string | null;
      docker_image: string | null;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        image_digest: agentSandboxes.image_digest,
        docker_image: agentSandboxes.docker_image,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          sql`${agentSandboxes.image_digest} IS DISTINCT FROM ${targetDigest}`,
          // Only reconcile agents on the configured default image. Per-agent
          // image overrides are intentional and must not be rolled onto the
          // global fleet tag.
          sql`(${agentSandboxes.docker_image} IS NULL OR ${agentSandboxes.docker_image} = ${targetImage})`,
          // Skip pool-owned rows (warm pool entries) — they get the new
          // image naturally on next claim, no need to disrupt them.
          sql`${agentSandboxes.pool_status} IS NULL`,
          // Only agents that actually run on a fleet container can be
          // blue/green upgraded. Shared-runtime / web-only agents are "running"
          // through the router origin with no node_id/container_name, so
          // executeUpgrade always returns "no node_id or container_name to
          // upgrade from" — and because the failed upgrade never changes their
          // digest, the reconciler re-selects them every cycle, producing an
          // endless agent_upgrade retry storm. Exclude them here.
          sql`${agentSandboxes.node_id} IS NOT NULL`,
          sql`${agentSandboxes.container_name} IS NOT NULL`,
        ),
      )
      .limit(limit);
  }

  /**
   * Find running, non-deleted agents currently on `currentDigest` that also
   * have a persisted `previous_image_digest`. Used by the operator-gated
   * rollback endpoint to enqueue downgrade jobs only for agents that can
   * actually roll back.
   */
  async listRollbackEligibleForDigest(
    currentDigest: string,
    targetImage: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      user_id: string;
      image_digest: string | null;
      previous_image_digest: string | null;
      docker_image: string | null;
    }>
  > {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
        user_id: agentSandboxes.user_id,
        image_digest: agentSandboxes.image_digest,
        previous_image_digest: agentSandboxes.previous_image_digest,
        docker_image: agentSandboxes.docker_image,
      })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.status, "running"),
          sql`${agentSandboxes.deleted_at} IS NULL`,
          eq(agentSandboxes.image_digest, currentDigest),
          isNotNull(agentSandboxes.previous_image_digest),
          sql`(${agentSandboxes.docker_image} IS NULL OR ${agentSandboxes.docker_image} = ${targetImage})`,
          sql`${agentSandboxes.pool_status} IS NULL`,
          sql`${agentSandboxes.node_id} IS NOT NULL`,
          sql`${agentSandboxes.container_name} IS NOT NULL`,
        ),
      )
      .limit(limit);
  }

  async findRunningSandbox(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    // Use dbWrite (primary) for fresh read-after-write data from the VPS worker.
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.id, id),
          eq(agentSandboxes.organization_id, orgId),
          eq(agentSandboxes.status, "running"),
        ),
      )
      .limit(1);
    return r;
  }

  async findByManagedDiscordGuildId(guildId: string): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const trimmedGuildId = guildId.trim();
    if (!trimmedGuildId) {
      return [];
    }

    const rows = await sqlRows<AgentSandbox>(
      dbWrite,
      sql`
      SELECT *
      FROM ${agentSandboxes}
      WHERE (${agentSandboxes.agent_config} -> ${AGENT_MANAGED_DISCORD_KEY} ->> 'guildId') = ${trimmedGuildId}
      ORDER BY ${agentSandboxes.updated_at} DESC
    `,
    );

    return rows;
  }

  // Writes

  async create(data: NewAgentSandbox): Promise<AgentSandbox> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite.insert(agentSandboxes).values(data).returning();
    if (!r) throw new Error("Failed to create Agent sandbox record");
    return r;
  }

  async markStuckProvisioningWithoutActiveJobAsError(cutoff: Date): Promise<
    Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      updatedAt: Date | null;
    }>
  > {
    await ensureAgentSandboxSchema();
    return dbWrite
      .update(agentSandboxes)
      .set({
        status: "error",
        error_message:
          "Agent was stuck in provisioning state with no active provisioning job. " +
          "This usually means a container crashed before the provisioning job could be created, " +
          "or the job was lost. Please try starting the agent again.",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(agentSandboxes.status, "provisioning"),
          lt(agentSandboxes.updated_at, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND    ${jobs.type} = 'agent_provision'
            AND    ${jobs.status} IN ('pending', 'in_progress')
          )`,
        ),
      )
      .returning({
        agentId: agentSandboxes.id,
        agentName: agentSandboxes.agent_name,
        organizationId: agentSandboxes.organization_id,
        updatedAt: agentSandboxes.updated_at,
      });
  }

  /**
   * Recover ORPHANED PENDING sandboxes: a user-owned row that was committed as
   * `pending` but never got an `agent_provision` job enqueued (a throw in the
   * create→enqueue window of the agents/coding-container/eliza-app paths). The
   * provisioning daemon only claims rows that HAVE a job, so such a row is
   * structurally unclaimable and would sit in `pending` forever with a null
   * error_message — a silent failure to the user.
   *
   * We MARK ERROR (never auto re-enqueue): the original env-prep may have
   * failed, so re-provisioning could spin up a half-configured agent. A clear
   * error makes the failure visible and lets the user retry the whole flow.
   *
   * `pool_status IS NULL` skips warm-pool rows, which are legitimately `pending`
   * with no per-agent job until claimed. Keyed on `created_at` (not
   * `updated_at`): the managed-env write bumps `updated_at`, so `created_at` is
   * the honest "how long has this been stuck" signal.
   */
  async markOrphanedPendingWithoutJobAsError(cutoff: Date): Promise<
    Array<{
      agentId: string;
      agentName: string | null;
      organizationId: string;
      createdAt: Date | null;
    }>
  > {
    await ensureAgentSandboxSchema();
    return dbWrite
      .update(agentSandboxes)
      .set({
        status: "error",
        error_message:
          "Provisioning never started: no agent_provision job was enqueued " +
          "(orphaned pending). Please retry.",
        updated_at: new Date(),
      })
      .where(
        and(
          eq(agentSandboxes.status, "pending"),
          sql`${agentSandboxes.pool_status} IS NULL`,
          lt(agentSandboxes.created_at, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM ${jobs}
            WHERE  ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND    ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND    ${jobs.type} = 'agent_provision'
            AND    ${jobs.status} IN ('pending', 'in_progress')
          )`,
        ),
      )
      .returning({
        agentId: agentSandboxes.id,
        agentName: agentSandboxes.agent_name,
        organizationId: agentSandboxes.organization_id,
        createdAt: agentSandboxes.created_at,
      });
  }

  async update(id: string, data: Partial<NewAgentSandbox>): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .update(agentSandboxes)
      .set({ ...data, updated_at: new Date() })
      .where(eq(agentSandboxes.id, id))
      .returning();
    return r;
  }

  /**
   * Atomically take the provisioning lock. `provisioning` is included so a
   * row left stuck by a crashed worker can be retaken; the job-level stale
   * recovery in ProvisioningJobService is the time-based gate.
   *
   * `running` is admitted ONLY for a never-containerized row
   * (`container_name IS NULL AND sandbox_id IS NULL`). A direct/shared provision
   * inserts the row as `running` BEFORE any container exists
   * (eliza-sandbox.ts buildAgentInsertData), so a half-provisioned row that
   * crashed before a container was created would otherwise be stuck at `running`
   * forever — none of the other admitted states match it, and the lock could
   * never be retaken, permanently blocking re-provision (the tonight outage).
   * The two NULL guards keep this STRICTLY off any genuinely-running dedicated
   * agent: the moment a container is created the provision path stamps
   * `container_name`/`sandbox_id`, so a live agent can NEVER satisfy this branch
   * and can NEVER have its lock taken from under it.
   */
  async trySetProvisioning(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "provisioning",
        updated_at: new Date(),
        error_message: null,
      })
      .where(
        and(
          eq(agentSandboxes.id, id),
          sql`(
            ${agentSandboxes.status} IN ('pending', 'provisioning', 'stopped', 'sleeping', 'disconnected', 'error')
            OR (
              ${agentSandboxes.status} = 'running'
              AND ${agentSandboxes.container_name} IS NULL
              AND ${agentSandboxes.sandbox_id} IS NULL
            )
          )`,
        ),
      )
      .returning();
    return r;
  }

  /**
   * Atomically restore a still-disconnected agent to `running` after a
   * successful bridge re-probe. The recovery read -> probe -> write window spans
   * seconds, during which the row may move to `deletion_pending` (delete
   * enqueue), `stopped` (shutdown nulls `bridge_url`), or `provisioning`
   * (re-provision). This compare-and-set only flips a row that is STILL
   * `disconnected` with a live bridge and not soft-deleted, so a stale probe can
   * never resurrect a being-deleted agent or wedge a stopped one at `running`
   * with a dead bridge. Returns the row when it won, undefined when it lost the
   * race (and the caller must NOT treat it as recovered).
   */
  async markReconnectedFromDisconnected(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .update(agentSandboxes)
      .set({ status: "running", last_heartbeat_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(agentSandboxes.id, id),
          eq(agentSandboxes.status, "disconnected"),
          sql`${agentSandboxes.bridge_url} IS NOT NULL`,
          sql`${agentSandboxes.deleted_at} IS NULL`,
        ),
      )
      .returning();
    return r;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    await ensureAgentSandboxSchema();
    const r = await dbWrite
      .delete(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .returning({ id: agentSandboxes.id });
    return r.length > 0;
  }

  // ── Warm pool ─────────────────────────────────────────────────────────

  /**
   * Count ready pool entries (status='running' AND pool_status='unclaimed').
   * Optionally filter by image so a stale image doesn't inflate the count.
   */
  async countUnclaimedPool(filter: { image?: string } = {}): Promise<number> {
    await ensureAgentSandboxSchema();
    const conditions = [
      eq(agentSandboxes.pool_status, "unclaimed"),
      eq(agentSandboxes.status, "running"),
      isNotNull(agentSandboxes.pool_ready_at),
    ];
    if (filter.image) conditions.push(eq(agentSandboxes.docker_image, filter.image));
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(and(...conditions));
    return row?.count ?? 0;
  }

  /**
   * Count pool entries by status — including not-yet-ready ones (still
   * provisioning). Used to size in-flight replenish work.
   */
  async countAllPoolEntries(): Promise<{ ready: number; provisioning: number }> {
    await ensureAgentSandboxSchema();
    const [ready] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(eq(agentSandboxes.pool_status, "unclaimed"), eq(agentSandboxes.status, "running")),
      );
    const [provisioning] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.pool_status, "unclaimed"),
          sql`${agentSandboxes.status} in ('pending','provisioning')`,
        ),
      );
    return { ready: ready?.count ?? 0, provisioning: provisioning?.count ?? 0 };
  }

  /**
   * Count user-facing provisions created in the given window.
   * Used by the forecast to predict next-period demand.
   * Excludes pool sentinel org rows.
   */
  /**
   * Count an org's NON-TERMINAL (`pending`/`provisioning`/`running`, non-pool)
   * agent sandboxes — the org's live dedicated-container footprint on the fleet.
   * Used by the create path's per-org quota (#11023). Best-effort read; the
   * authoritative check runs under the advisory lock inside createAgent.
   */
  async countNonTerminalByOrganization(organizationId: string): Promise<number> {
    await ensureAgentSandboxSchema();
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.pool_status} is null`,
          sql`${agentSandboxes.status} in ('pending', 'provisioning', 'running')`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Count retained user-owned agent rows for an organization. Used by org-vacate
   * guards where deleting the org would cascade agent state without going
   * through the provisioning teardown path.
   */
  async countRetainedByOrganization(organizationId: string): Promise<number> {
    await ensureAgentSandboxSchema();
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.organization_id, organizationId),
          sql`${agentSandboxes.pool_status} is null`,
          sql`${agentSandboxes.deleted_at} is null`,
        ),
      );
    return row?.count ?? 0;
  }

  async countUserProvisionsSince(sinceMs: number): Promise<number> {
    await ensureAgentSandboxSchema();
    const since = new Date(Date.now() - sinceMs);
    const [row] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(agentSandboxes)
      .where(
        and(
          gte(agentSandboxes.created_at, since),
          sql`${agentSandboxes.organization_id} <> ${WARM_POOL_ORG_ID}`,
          sql`${agentSandboxes.pool_status} is null`,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * User provisions per UTC hour over the last `windowHours`, oldest first.
   * Excludes pool sentinel org rows. Used by the forecast.
   */
  async countUserProvisionsByHour(windowHours: number): Promise<number[]> {
    await ensureAgentSandboxSchema();
    if (windowHours <= 0) return [];
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await sqlRows<{ bucket: string; count: number }>(
      dbRead,
      sql`
        SELECT
          to_char(date_trunc('hour', ${agentSandboxes.created_at}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00') as bucket,
          count(*)::int as count
        FROM ${agentSandboxes}
        WHERE ${agentSandboxes.created_at} >= ${since}
          AND ${agentSandboxes.organization_id} <> ${WARM_POOL_ORG_ID}
          AND ${agentSandboxes.pool_status} IS NULL
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    );
    const byBucket = new Map(rows.map((r) => [r.bucket, r.count]));

    const buckets: number[] = [];
    const nowMs = Date.now();
    const startHourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
    for (let i = windowHours - 1; i >= 0; i--) {
      const ms = startHourMs - i * 3_600_000;
      const key = new Date(ms).toISOString().slice(0, 13) + ":00:00";
      buckets.push(byBucket.get(key) ?? 0);
    }
    return buckets;
  }

  /** All ready unclaimed pool rows — for health probing and image rollout. */
  async listUnclaimedPool(): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.pool_status, "unclaimed"), eq(agentSandboxes.status, "running")))
      .orderBy(agentSandboxes.pool_ready_at);
  }

  /**
   * Pool rows that started provisioning but never became ready. Used to
   * reap stuck containers so the pool replenisher can retry.
   */
  async findStuckPoolProvisioning(staleThresholdMs: number): Promise<AgentSandbox[]> {
    await ensureAgentSandboxSchema();
    const cutoff = new Date(Date.now() - staleThresholdMs);
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(
        and(
          eq(agentSandboxes.pool_status, "unclaimed"),
          sql`${agentSandboxes.status} in ('pending','provisioning','error')`,
          lt(agentSandboxes.updated_at, cutoff),
        ),
      );
  }

  /**
   * Atomically claim a warm pool entry on behalf of a user's pending
   * sandbox row. Uses `FOR UPDATE SKIP LOCKED` so concurrent claims pick
   * different pool rows and never block each other.
   *
   * On success, the user's row inherits all docker infrastructure fields
   * from the pool row, status flips to 'running', and the pool row is
   * deleted in the same transaction.
   *
   * Returns the updated user row, or null when the pool is empty.
   */
  async claimWarmContainer(params: {
    userAgentId: string;
    organizationId: string;
    image: string;
    agentName: string;
    agentConfig?: Record<string, unknown>;
    characterId?: string | null;
    expectedUpdatedAt?: Date | string | null;
  }): Promise<AgentSandbox | null> {
    await ensureAgentSandboxSchema();
    return dbWrite.transaction(async (tx) => {
      const poolRows = await sqlRows<AgentSandbox>(
        tx,
        sql`
          SELECT *
          FROM ${agentSandboxes}
          WHERE ${agentSandboxes.pool_status} = 'unclaimed'
            AND ${agentSandboxes.status} = 'running'
            AND ${agentSandboxes.docker_image} = ${params.image}
            AND ${agentSandboxes.pool_ready_at} IS NOT NULL
          ORDER BY ${agentSandboxes.pool_ready_at} ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
      );
      const pool = poolRows[0];
      if (!pool) return null;

      const [userRow] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.id, params.userAgentId),
            eq(agentSandboxes.organization_id, params.organizationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!userRow) return null;

      // Pool claim is for fresh provisions only. If the user's row already
      // has a database, fall through to the existing provision flow which
      // will reuse it. Likewise if it's already running.
      if (userRow.database_status === "ready" || userRow.database_uri) return null;
      if (userRow.status === "running") return null;

      if (params.expectedUpdatedAt) {
        const expectedMs = new Date(params.expectedUpdatedAt).getTime();
        const currentMs = userRow.updated_at?.getTime() ?? Number.NaN;
        if (Number.isFinite(expectedMs) && Number.isFinite(currentMs) && expectedMs !== currentMs) {
          return null;
        }
      }

      const claimedAt = new Date();
      const [updated] = await tx
        .update(agentSandboxes)
        .set({
          status: "running",
          node_id: pool.node_id,
          container_name: pool.container_name,
          bridge_port: pool.bridge_port,
          web_ui_port: pool.web_ui_port,
          headscale_ip: pool.headscale_ip,
          docker_image: pool.docker_image,
          bridge_url: pool.bridge_url,
          health_url: pool.health_url,
          sandbox_id: pool.sandbox_id,
          // Database transfer — pool row's database is now the user's.
          database_uri: pool.database_uri,
          database_status: pool.database_status,
          agent_name: params.agentName,
          agent_config: params.agentConfig ?? userRow.agent_config,
          character_id: params.characterId ?? userRow.character_id,
          claimed_at: claimedAt,
          updated_at: claimedAt,
          error_message: null,
        })
        .where(eq(agentSandboxes.id, params.userAgentId))
        .returning();

      await tx.delete(agentSandboxes).where(eq(agentSandboxes.id, pool.id));

      return updated ?? null;
    });
  }

  /** Insert a pool entry pre-bound to the sentinel pool org. */
  async createPoolEntry(
    data: Omit<NewAgentSandbox, "organization_id" | "user_id" | "pool_status">,
  ): Promise<AgentSandbox> {
    await ensureAgentSandboxSchema();
    const [row] = await dbWrite
      .insert(agentSandboxes)
      .values({
        ...data,
        organization_id: WARM_POOL_ORG_ID,
        user_id: WARM_POOL_USER_ID,
        pool_status: "unclaimed",
      })
      .returning();
    if (!row) throw new Error("Failed to create warm pool entry");
    return row;
  }

  /** Hard-delete a pool entry by id. Caller is responsible for stopping the container. */
  async deletePoolEntry(id: string): Promise<boolean> {
    await ensureAgentSandboxSchema();
    const r = await dbWrite
      .delete(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.pool_status, "unclaimed")))
      .returning({ id: agentSandboxes.id });
    return r.length > 0;
  }

  /** Mark a pool entry ready (called after health check passes post-provision). */
  async markPoolEntryReady(id: string): Promise<AgentSandbox | undefined> {
    await ensureAgentSandboxSchema();
    const [r] = await dbWrite
      .update(agentSandboxes)
      .set({
        status: "running",
        pool_ready_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.pool_status, "unclaimed")))
      .returning();
    return r;
  }

  // Backups

  async createBackup(data: NewAgentSandboxBackup): Promise<AgentSandboxBackup> {
    const insertData = await prepareAgentBackupInsertData(data);
    const [r] = await dbWrite.insert(agentSandboxBackups).values(insertData).returning();
    if (!r) throw new Error("Failed to create backup");
    return await hydrateAgentSandboxBackup(r);
  }

  async listBackups(sandboxRecordId: string, limit = 10): Promise<AgentSandboxBackup[]> {
    const rows = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(limit);
    return await Promise.all(rows.map(hydrateAgentSandboxBackup));
  }

  async listBackupMetadata(
    sandboxRecordId: string,
    limit = 10,
  ): Promise<AgentSandboxBackupMetadata[]> {
    return await dbRead
      .select({
        id: agentSandboxBackups.id,
        sandbox_record_id: agentSandboxBackups.sandbox_record_id,
        snapshot_type: agentSandboxBackups.snapshot_type,
        state_data_storage: agentSandboxBackups.state_data_storage,
        state_data_key: agentSandboxBackups.state_data_key,
        size_bytes: agentSandboxBackups.size_bytes,
        backup_kind: agentSandboxBackups.backup_kind,
        parent_backup_id: agentSandboxBackups.parent_backup_id,
        content_hash: agentSandboxBackups.content_hash,
        created_at: agentSandboxBackups.created_at,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(limit);
  }

  async getLatestBackup(sandboxRecordId: string): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(1);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  /**
   * The newest backup of a given `snapshot_type` for a sandbox. Used by
   * `executeDowngrade` to find the `pre-upgrade` restore point captured right
   * before the most recent fleet upgrade.
   */
  async getLatestBackupByType(
    sandboxRecordId: string,
    snapshotType: AgentBackupSnapshotType,
  ): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId),
          eq(agentSandboxBackups.snapshot_type, snapshotType),
        ),
      )
      .orderBy(desc(agentSandboxBackups.created_at))
      .limit(1);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  async getBackupById(backupId: string): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId))
      .limit(1);
    return r ? await hydrateAgentSandboxBackup(r) : undefined;
  }

  /**
   * Chain-safe prune: keep the newest `keep` restore points plus every
   * ancestor any retained incremental still needs, then delete the rest. This
   * can never strand an incremental backup without the full backup it builds
   * on. See `selectPrunableBackupIds`.
   */
  async pruneBackups(sandboxRecordId: string, keep: number): Promise<number> {
    const all = await dbRead
      .select({
        id: agentSandboxBackups.id,
        backupKind: agentSandboxBackups.backup_kind,
        parentBackupId: agentSandboxBackups.parent_backup_id,
        createdAt: agentSandboxBackups.created_at,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId));
    if (all.length <= keep) return 0;
    const nodes: BackupChainNode[] = all.map((b) => ({
      id: b.id,
      backupKind: b.backupKind,
      parentBackupId: b.parentBackupId,
      createdAtMs: b.createdAt.getTime(),
    }));
    const ids = selectPrunableBackupIds(nodes, keep);
    if (ids.length === 0) return 0;
    const r = await dbWrite
      .delete(agentSandboxBackups)
      .where(inArray(agentSandboxBackups.id, ids))
      .returning({ id: agentSandboxBackups.id });
    return r.length;
  }

  /**
   * Reconstruct the full agent state for a backup. For `full` backups this is
   * the stored state verbatim; for `incremental` backups it replays the parent
   * chain (oldest full → … → target) applying each delta. All consumers that
   * need state to restore (provision auto-restore, `restore()`) MUST go through
   * here so incrementals are transparently materialized.
   */
  async getReconstructedBackupState(backupId: string): Promise<AgentBackupStateData | undefined> {
    const target = await this.getBackupById(backupId);
    if (!target) return undefined;
    if (target.backup_kind !== "incremental") {
      return requireBackupStateData(target.state_data, target.id);
    }
    const all = await this.listBackups(target.sandbox_record_id, 1000);
    const nodes: BackupChainNode[] = all.map((b) => ({
      id: b.id,
      backupKind: b.backup_kind,
      parentBackupId: b.parent_backup_id,
      createdAtMs: b.created_at.getTime(),
    }));
    const byId = new Map(all.map((b) => [b.id, b]));
    let state: AgentBackupStateData | undefined;
    for (const id of resolveBackupChain(nodes, backupId)) {
      const row = byId.get(id);
      if (!row) throw new Error(`Backup chain row ${id} vanished mid-reconstruct`);
      if (row.backup_kind === "full") {
        state = requireBackupStateData(row.state_data, row.id);
      } else {
        if (!state) throw new Error(`Incremental ${id} reached before a full backup`);
        state = applyBackupDelta(state, requireBackupDelta(row.state_data, row.id));
      }
    }
    return state;
  }
}

export const agentSandboxesRepository = new AgentSandboxesRepository();
