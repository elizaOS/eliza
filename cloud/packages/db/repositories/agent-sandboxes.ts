import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { sqlRows } from "@/db/execute-helpers";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type AgentBackupSnapshotType,
  type AgentSandbox,
  type AgentSandboxBackup,
  type AgentSandboxStatus,
  agentSandboxBackups,
  agentSandboxes,
  type NewAgentSandbox,
  type NewAgentSandboxBackup,
  WARM_POOL_ORG_ID,
  WARM_POOL_USER_ID,
} from "@/db/schemas/agent-sandboxes";
import { AGENT_MANAGED_DISCORD_KEY } from "@/lib/services/eliza-agent-config";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { getObjectText, offloadJsonField } from "@/lib/storage/object-store";

export type {
  AgentBackupSnapshotType,
  AgentSandbox,
  AgentSandboxBackup,
  AgentSandboxStatus,
  NewAgentSandbox,
  NewAgentSandboxBackup,
};

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
  backup: AgentSandboxBackup,
): Promise<AgentSandboxBackup> {
  if (backup.state_data_storage !== "r2") return backup;
  if (!backup.state_data_key) {
    throw new Error(`Agent sandbox backup ${backup.id} is missing state_data_key`);
  }

  const raw = await getObjectText(backup.state_data_key);
  if (!raw) {
    throw new Error(`Agent sandbox backup payload not found: ${backup.state_data_key}`);
  }

  return {
    ...backup,
    state_data: JSON.parse(raw) as AgentSandboxBackup["state_data"],
  };
}

export async function prepareAgentBackupInsertData(
  data: NewAgentSandboxBackup,
  organizationId?: string,
): Promise<NewAgentSandboxBackup> {
  if (data.state_data_storage === "r2") return data;

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const stateData = await offloadJsonField<AgentSandboxBackup["state_data"]>({
    namespace: ObjectNamespaces.AgentSandboxBackups,
    organizationId: organizationId ?? (await backupOrganizationId(data.sandbox_record_id)),
    objectId: id,
    field: "state_data",
    createdAt,
    value: data.state_data,
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
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, id))
      .limit(1);
    return r;
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async findByIdAndOrgForWrite(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    const [r] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.organization_id, orgId)))
      .limit(1);
    return r;
  }

  async listByOrganization(orgId: string): Promise<AgentSandbox[]> {
    return dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.organization_id, orgId))
      .orderBy(desc(agentSandboxes.created_at));
  }

  async findBySandboxId(sandboxId: string): Promise<AgentSandbox | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.sandbox_id, sandboxId))
      .limit(1);
    return r;
  }

  /** List active (non-terminal) sandboxes on a specific docker node. */
  async listByNodeId(nodeId: string): Promise<AgentSandbox[]> {
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

  async listRunning(): Promise<Array<{ id: string; organization_id: string }>> {
    return dbRead
      .select({
        id: agentSandboxes.id,
        organization_id: agentSandboxes.organization_id,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.status, "running"));
  }

  async findRunningSandbox(id: string, orgId: string): Promise<AgentSandbox | undefined> {
    // Use dbWrite (primary) instead of dbRead (replica) to ensure fresh data.
    // The VPS worker writes bridge_url/status to primary, and read replicas
    // may lag behind, causing the wallet proxy to return "not running".
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
    const [r] = await dbWrite.insert(agentSandboxes).values(data).returning();
    if (!r) throw new Error("Failed to create Agent sandbox record");
    return r;
  }

  async update(id: string, data: Partial<NewAgentSandbox>): Promise<AgentSandbox | undefined> {
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
   */
  async trySetProvisioning(id: string): Promise<AgentSandbox | undefined> {
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
          sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'stopped', 'disconnected', 'error')`,
        ),
      )
      .returning();
    return r;
  }

  async delete(id: string, orgId: string): Promise<boolean> {
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
  async countUserProvisionsSince(sinceMs: number): Promise<number> {
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
          // Neon database transfer — pool row's database is now the user's.
          neon_project_id: pool.neon_project_id,
          neon_branch_id: pool.neon_branch_id,
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
    const r = await dbWrite
      .delete(agentSandboxes)
      .where(and(eq(agentSandboxes.id, id), eq(agentSandboxes.pool_status, "unclaimed")))
      .returning({ id: agentSandboxes.id });
    return r.length > 0;
  }

  /** Mark a pool entry ready (called after health check passes post-provision). */
  async markPoolEntryReady(id: string): Promise<AgentSandbox | undefined> {
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

  async getLatestBackup(sandboxRecordId: string): Promise<AgentSandboxBackup | undefined> {
    const [r] = await dbRead
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
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

  async pruneBackups(sandboxRecordId: string, keep: number): Promise<number> {
    const all = await dbRead
      .select({ id: agentSandboxBackups.id })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.sandbox_record_id, sandboxRecordId))
      .orderBy(desc(agentSandboxBackups.created_at));
    if (all.length <= keep) return 0;
    const ids = all.slice(keep).map((b) => b.id);
    const r = await dbWrite
      .delete(agentSandboxBackups)
      .where(inArray(agentSandboxBackups.id, ids))
      .returning({ id: agentSandboxBackups.id });
    return r.length;
  }
}

export const agentSandboxesRepository = new AgentSandboxesRepository();
