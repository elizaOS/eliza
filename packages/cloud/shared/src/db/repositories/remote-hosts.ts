/** Tenant-scoped persistence for user-owned Macs and VPS runtime hosts. */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { dbWrite } from "../helpers";
import { type NewRemoteHost, type RemoteHost, remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";

export class RemoteHostsRepository {
  constructor(private readonly database = dbWrite) {}

  async create(input: NewRemoteHost): Promise<RemoteHost> {
    const [row] = await this.database.insert(remoteHosts).values(input).returning();
    if (!row) throw new Error("Failed to create remote host");
    return row;
  }

  async listOwned(organizationId: string, userId: string): Promise<RemoteHost[]> {
    return this.database
      .select()
      .from(remoteHosts)
      .where(
        and(
          eq(remoteHosts.organization_id, organizationId),
          eq(remoteHosts.user_id, userId),
          isNull(remoteHosts.revoked_at),
        ),
      )
      .orderBy(desc(remoteHosts.created_at));
  }

  async getOwned(
    hostId: string,
    organizationId: string,
    userId: string,
  ): Promise<RemoteHost | undefined> {
    const [host] = await this.database
      .select()
      .from(remoteHosts)
      .where(
        and(
          eq(remoteHosts.id, hostId),
          eq(remoteHosts.organization_id, organizationId),
          eq(remoteHosts.user_id, userId),
          isNull(remoteHosts.revoked_at),
        ),
      )
      .limit(1);
    return host;
  }

  async revoke(
    hostId: string,
    organizationId: string,
    userId: string,
  ): Promise<RemoteHost | undefined> {
    const now = new Date();
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .update(remoteHosts)
        .set({ status: "revoked", revoked_at: now, updated_at: now })
        .where(
          and(
            eq(remoteHosts.id, hostId),
            eq(remoteHosts.organization_id, organizationId),
            eq(remoteHosts.user_id, userId),
            isNull(remoteHosts.revoked_at),
          ),
        )
        .returning();
      if (!row) return undefined;
      await tx
        .update(remoteSessions)
        .set({ status: "revoked", ended_at: now, updated_at: now })
        .where(
          and(
            eq(remoteSessions.host_id, hostId),
            eq(remoteSessions.organization_id, organizationId),
            eq(remoteSessions.user_id, userId),
            inArray(remoteSessions.status, ["pending", "active"]),
          ),
        );
      return row;
    });
  }
}

export const remoteHostsRepository = new RemoteHostsRepository();
