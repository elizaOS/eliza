import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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

  /** Atomically set provisioning — only from pending/stopped/disconnected/error. */
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
          sql`${agentSandboxes.status} IN ('pending', 'stopped', 'disconnected', 'error')`,
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
