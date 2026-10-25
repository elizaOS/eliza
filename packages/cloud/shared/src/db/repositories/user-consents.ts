// Persists the append-only user consent ledger through the shared DB boundary.
import { and, desc, eq } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbWrite } from "../helpers";
import {
  type NewUserConsent,
  USER_CONSENT_PURPOSES,
  type UserConsent,
  type UserConsentPurpose,
  userConsents,
} from "../schemas/user-consents";

export type { NewUserConsent, UserConsent, UserConsentPurpose };

/**
 * Append-only access to `user_consents`. There is deliberately no update or
 * delete: a new decision is a new row, and the latest row per purpose is the
 * user's current choice. Every read is scoped to the (user, organization).
 */
export class UserConsentsRepository {
  /** Record one decision. Runs on `tx` so an audit write can share the commit. */
  async append(data: NewUserConsent, tx?: DbTransaction): Promise<UserConsent> {
    const [row] = await (tx ?? dbWrite).insert(userConsents).values(data).returning();
    return row;
  }

  /**
   * Latest decision for one purpose, or undefined when the user never chose.
   * Reads the primary: a revocation must take effect on the next capture
   * check, not after replica lag.
   */
  async findLatest(
    userId: string,
    organizationId: string,
    purpose: UserConsentPurpose,
  ): Promise<UserConsent | undefined> {
    const [row] = await dbWrite
      .select()
      .from(userConsents)
      .where(
        and(
          eq(userConsents.user_id, userId),
          eq(userConsents.organization_id, organizationId),
          eq(userConsents.purpose, purpose),
        ),
      )
      .orderBy(desc(userConsents.recorded_at), desc(userConsents.id))
      .limit(1);
    return row;
  }

  /** Latest decision per purpose, in {@link USER_CONSENT_PURPOSES} order. */
  async listLatest(userId: string, organizationId: string): Promise<UserConsent[]> {
    const latest = await Promise.all(
      USER_CONSENT_PURPOSES.map((purpose) => this.findLatest(userId, organizationId, purpose)),
    );
    return latest.filter((row): row is UserConsent => row !== undefined);
  }
}

export const userConsentsRepository = new UserConsentsRepository();
