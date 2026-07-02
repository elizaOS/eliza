import { and, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewPooledCredential,
  type PooledCredential,
  type PooledCredentialUsage,
  pooledCredentials,
  pooledCredentialUsage,
} from "../schemas/pooled-credentials";
import { users } from "../schemas/users";

export type { NewPooledCredential, PooledCredential, PooledCredentialUsage };

export interface PooledCredentialWithContributor extends PooledCredential {
  contributor_name: string | null;
  contributor_email: string | null;
}

/**
 * Row-level pool-state mutation — ONLY the metadata columns the AccountPool
 * brain owns. Never touches secret_id / provider / organization_id, so a
 * concurrent health write can never clobber identity fields (fixes the
 * self-host read-modify-write blob hazard by construction).
 */
export interface PooledCredentialPoolState {
  label?: string;
  enabled?: boolean;
  priority?: number;
  health?: string;
  health_detail?: PooledCredential["health_detail"];
  usage?: PooledCredential["usage"];
  last_used_at?: Date | null;
}

/**
 * Repository for the team credential pool (#11332).
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class PooledCredentialsRepository {
  // ==========================================================================
  // READ OPERATIONS (use read-intent connection)
  // ==========================================================================

  async findById(id: string): Promise<PooledCredential | undefined> {
    const rows = await dbRead
      .select()
      .from(pooledCredentials)
      .where(eq(pooledCredentials.id, id))
      .limit(1);
    return rows[0];
  }

  async listByOrganization(organizationId: string): Promise<PooledCredential[]> {
    return await dbRead
      .select()
      .from(pooledCredentials)
      .where(eq(pooledCredentials.organization_id, organizationId))
      .orderBy(pooledCredentials.priority, pooledCredentials.created_at);
  }

  /** Org list with contributor identity joined in, for the masked GET surface. */
  async listByOrganizationWithContributor(
    organizationId: string,
  ): Promise<PooledCredentialWithContributor[]> {
    const rows = await dbRead
      .select({
        credential: pooledCredentials,
        contributor_name: users.name,
        contributor_email: users.email,
      })
      .from(pooledCredentials)
      .leftJoin(users, eq(pooledCredentials.contributed_by, users.id))
      .where(eq(pooledCredentials.organization_id, organizationId))
      .orderBy(pooledCredentials.priority, pooledCredentials.created_at);
    return rows.map((row) => ({
      ...row.credential,
      contributor_name: row.contributor_name,
      contributor_email: row.contributor_email,
    }));
  }

  /** Today's per-credential call totals for an org (UTC day bucket). */
  async usageTotalsForDay(organizationId: string, day: string): Promise<Map<string, number>> {
    const rows = await dbRead
      .select({
        credential_id: pooledCredentialUsage.credential_id,
        calls: sql<number>`sum(${pooledCredentialUsage.calls})::int`,
      })
      .from(pooledCredentialUsage)
      .where(
        and(
          eq(pooledCredentialUsage.organization_id, organizationId),
          eq(pooledCredentialUsage.day, day),
        ),
      )
      .groupBy(pooledCredentialUsage.credential_id);
    return new Map(rows.map((row) => [row.credential_id, row.calls]));
  }

  async listUsageByCredential(credentialId: string): Promise<PooledCredentialUsage[]> {
    return await dbRead
      .select()
      .from(pooledCredentialUsage)
      .where(eq(pooledCredentialUsage.credential_id, credentialId))
      .orderBy(pooledCredentialUsage.day);
  }

  // ==========================================================================
  // WRITE OPERATIONS (use primary connection)
  // ==========================================================================

  async create(data: NewPooledCredential): Promise<PooledCredential> {
    const rows = await dbWrite.insert(pooledCredentials).values(data).returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to insert pooled credential");
    return row;
  }

  /**
   * Row-level UPDATE of pool metadata columns only (see
   * {@link PooledCredentialPoolState}). Returns the updated row, or undefined
   * when the row no longer exists.
   */
  async updatePoolState(
    id: string,
    state: PooledCredentialPoolState,
  ): Promise<PooledCredential | undefined> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (state.label !== undefined) set.label = state.label;
    if (state.enabled !== undefined) set.enabled = state.enabled;
    if (state.priority !== undefined) set.priority = state.priority;
    if (state.health !== undefined) set.health = state.health;
    if (state.health_detail !== undefined) set.health_detail = state.health_detail;
    if (state.usage !== undefined) set.usage = state.usage;
    if (state.last_used_at !== undefined) set.last_used_at = state.last_used_at;
    const rows = await dbWrite
      .update(pooledCredentials)
      .set(set)
      .where(eq(pooledCredentials.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string): Promise<PooledCredential | undefined> {
    const rows = await dbWrite
      .delete(pooledCredentials)
      .where(eq(pooledCredentials.id, id))
      .returning();
    return rows[0];
  }

  /** Increment the (credential, user, UTC-day) rollup counter by one call. */
  async recordDailyUsage(params: {
    organizationId: string;
    credentialId: string;
    userId: string;
    day: string;
  }): Promise<void> {
    await dbWrite
      .insert(pooledCredentialUsage)
      .values({
        organization_id: params.organizationId,
        credential_id: params.credentialId,
        user_id: params.userId,
        day: params.day,
        calls: 1,
      })
      .onConflictDoUpdate({
        target: [
          pooledCredentialUsage.credential_id,
          pooledCredentialUsage.user_id,
          pooledCredentialUsage.day,
        ],
        set: {
          calls: sql`${pooledCredentialUsage.calls} + 1`,
          updated_at: new Date(),
        },
      });
  }
}

export const pooledCredentialsRepository = new PooledCredentialsRepository();
