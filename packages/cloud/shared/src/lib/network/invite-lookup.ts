/** Postgres-backed {@link NetworkInviteLookup} over the `network` schema (0474). */

import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { networkInvites, networkMembers } from "../../db/network/schema";
import type { NetworkInviteLookup } from "./inbound-gate";

type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Read-only lookup: an accepted invite, a live (pending, unexpired) invite, or
 * a non-removed member admits the phone. The first admitted message accepts the
 * invite (see membership.ts `linkInvitedPhone`).
 */
export function createPostgresNetworkInviteLookup(
  database: AnyPgDatabase | (() => Promise<AnyPgDatabase>),
): NetworkInviteLookup {
  const resolve = typeof database === "function" ? database : async () => database;
  return {
    async isInvitedOrMember({ address }) {
      const db = await resolve();
      const [invite] = await db
        .select({ found: sql<number>`1` })
        .from(networkInvites)
        .where(
          and(
            eq(networkInvites.phoneE164, address),
            or(
              eq(networkInvites.status, "accepted"),
              and(
                eq(networkInvites.status, "pending"),
                or(isNull(networkInvites.expiresAt), gt(networkInvites.expiresAt, sql`now()`)),
              ),
            ),
          ),
        )
        .limit(1);
      if (invite) return true;
      const [member] = await db
        .select({ found: sql<number>`1` })
        .from(networkMembers)
        .where(and(eq(networkMembers.phoneE164, address), ne(networkMembers.state, "removed")))
        .limit(1);
      return Boolean(member);
    },
  };
}

/**
 * Production lookup. The database client is imported lazily so route modules
 * stay cheap at Worker startup (see bootstrap-app.ts startup-CPU note).
 */
export const networkInviteLookup: NetworkInviteLookup = createPostgresNetworkInviteLookup(
  async () => (await import("../../db/client")).dbRead as unknown as AnyPgDatabase,
);
