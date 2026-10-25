/**
 * Atomic persistence for the cross-host SSO bridge: exactly-once code claims
 * via `DELETE … RETURNING` and read-your-writes logout markers. This is the
 * store that makes the bridge's two security invariants ("single-use code"
 * and "logout stays logged out") hold on the DEPLOYED Worker, whose cache
 * backend (Cloudflare KV) is non-atomic and eventually consistent — see the
 * schema header (`../schemas/sso-bridge.ts`) and the service layer
 * (`lib/services/sso-bridge-codes.ts`).
 */

import { and, eq, gt, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewSsoBridgeCode,
  type SsoBridgeCode,
  type SsoBridgeLogoutMarker,
  ssoBridgeCodes,
  ssoBridgeLogoutMarkers,
} from "../schemas/sso-bridge";

export type { NewSsoBridgeCode, SsoBridgeCode, SsoBridgeLogoutMarker };

export class SsoBridgeRepository {
  /**
   * Insert a pending code row. The primary key on `code_hash` makes an
   * (astronomically unlikely) collision a loud unique-violation throw instead
   * of a silent overwrite of another user's pending handshake.
   */
  async insertCode(row: NewSsoBridgeCode): Promise<SsoBridgeCode> {
    const [inserted] = await dbWrite.insert(ssoBridgeCodes).values(row).returning();
    if (!inserted) {
      throw new Error("SsoBridgeRepository: failed to insert bridge code");
    }
    return inserted;
  }

  /**
   * Atomically claim (and destroy) a live code: a single-statement
   * `DELETE … RETURNING` guarded by the TTL, so exactly one of any number of
   * concurrent presenters receives the row and every other presenter — and
   * every later replay — gets `undefined`.
   */
  async claimCode(codeHash: string, now: Date = new Date()): Promise<SsoBridgeCode | undefined> {
    const [claimed] = await dbWrite
      .delete(ssoBridgeCodes)
      .where(and(eq(ssoBridgeCodes.code_hash, codeHash), gt(ssoBridgeCodes.expires_at, now)))
      .returning();
    return claimed;
  }

  /** Opportunistic cleanup of expired, never-claimed codes (rows are ~60s-lived). */
  async purgeExpiredCodes(now: Date = new Date()): Promise<number> {
    const purged = await dbWrite
      .delete(ssoBridgeCodes)
      .where(lte(ssoBridgeCodes.expires_at, now))
      .returning({ code_hash: ssoBridgeCodes.code_hash });
    return purged.length;
  }

  /**
   * Stamp "this user explicitly logged out at `at`". Upsert keeps one row per
   * user; GREATEST means the marker only ever moves forward, so a delayed or
   * replayed stamp can never rewind a newer logout.
   */
  async stampLogout(stewardUserId: string, at: Date = new Date()): Promise<void> {
    await dbWrite
      .insert(ssoBridgeLogoutMarkers)
      .values({ steward_user_id: stewardUserId, logged_out_at: at })
      .onConflictDoUpdate({
        target: ssoBridgeLogoutMarkers.steward_user_id,
        set: {
          logged_out_at: sql`GREATEST(${ssoBridgeLogoutMarkers.logged_out_at}, excluded.logged_out_at)`,
        },
      });
  }

  /** Read the user's logout marker; throws on backend failure (callers fail closed). */
  async getLogoutMarker(stewardUserId: string): Promise<SsoBridgeLogoutMarker | undefined> {
    const [marker] = await dbRead
      .select()
      .from(ssoBridgeLogoutMarkers)
      .where(eq(ssoBridgeLogoutMarkers.steward_user_id, stewardUserId))
      .limit(1);
    return marker;
  }

  /**
   * Read a logout marker from the primary connection for a security decision
   * that must observe a just-committed logout without replica lag.
   */
  async getLogoutMarkerForWrite(stewardUserId: string): Promise<SsoBridgeLogoutMarker | undefined> {
    const [marker] = await dbWrite
      .select()
      .from(ssoBridgeLogoutMarkers)
      .where(eq(ssoBridgeLogoutMarkers.steward_user_id, stewardUserId))
      .limit(1);
    return marker;
  }

  /**
   * Drop markers older than `olderThan`. A marker only needs to outlive the
   * access-token lifetime — every pre-logout token has expired by then.
   */
  async purgeLogoutMarkersOlderThan(olderThan: Date): Promise<number> {
    const purged = await dbWrite
      .delete(ssoBridgeLogoutMarkers)
      .where(lte(ssoBridgeLogoutMarkers.logged_out_at, olderThan))
      .returning({ steward_user_id: ssoBridgeLogoutMarkers.steward_user_id });
    return purged.length;
  }
}

export const ssoBridgeRepository = new SsoBridgeRepository();
