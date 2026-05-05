import { and, desc, eq, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type NewRemoteSession,
  type RemoteSession,
  type RemoteSessionStatus,
  remoteSessions,
} from "@/db/schemas/remote-sessions";

export type { NewRemoteSession, RemoteSession, RemoteSessionStatus };

const ACTIVE_STATUSES: RemoteSessionStatus[] = ["pending", "active"];

export class RemoteSessionsRepository {
  async create(data: NewRemoteSession): Promise<RemoteSession> {
    const [row] = await dbWrite.insert(remoteSessions).values(data).returning();
    if (!row) {
      throw new Error("Failed to create remote session");
    }
    return row;
  }

  async findByIdAndOrg(id: string, orgId: string): Promise<RemoteSession | undefined> {
    const [row] = await dbRead
      .select()
      .from(remoteSessions)
      .where(and(eq(remoteSessions.id, id), eq(remoteSessions.organization_id, orgId)))
      .limit(1);
    return row;
  }

  async listActiveByAgent(agentId: string, orgId: string): Promise<RemoteSession[]> {
    return dbRead
      .select()
      .from(remoteSessions)
      .where(
        and(
          eq(remoteSessions.agent_id, agentId),
          eq(remoteSessions.organization_id, orgId),
          inArray(remoteSessions.status, ACTIVE_STATUSES),
        ),
      )
      .orderBy(desc(remoteSessions.created_at));
  }

  async revoke(id: string, orgId: string): Promise<RemoteSession | undefined> {
    const now = new Date();
    const [row] = await dbWrite
      .update(remoteSessions)
      .set({ status: "revoked", updated_at: now, ended_at: now })
      .where(
        and(
          eq(remoteSessions.id, id),
          eq(remoteSessions.organization_id, orgId),
          inArray(remoteSessions.status, ACTIVE_STATUSES),
        ),
      )
      .returning();
    return row;
  }
}

export const remoteSessionsRepository = new RemoteSessionsRepository();
