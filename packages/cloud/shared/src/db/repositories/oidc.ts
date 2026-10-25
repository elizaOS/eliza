/**
 * Atomic persistence for the OpenID Connect provider.
 *
 * `claimCode` / `claimRequest` are single-statement `DELETE … RETURNING`
 * guarded by the row's TTL, which is what makes "an authorization code is
 * redeemed exactly once" hold across Worker isolates — every concurrent
 * presenter but one, and every later replay, receives `undefined`. The same
 * shape backs the SSO bridge (`./sso-bridge.ts`); see the schema header
 * (`../schemas/oidc.ts`) for why this is Postgres and not the KV-backed cache.
 *
 * `allocateUsername` is deliberately insert-only: the OIDC username is a
 * permanent, externally-visible identifier a relying party keys accounts on,
 * so this repository exposes no update path for it.
 */

import { and, eq, gt, lte } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewOidcAuthorizationCode,
  type NewOidcAuthorizationRequest,
  type OidcAuthorizationCode,
  type OidcAuthorizationRequest,
  type OidcUserProfile,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcUserProfiles,
} from "../schemas/oidc";

export type {
  NewOidcAuthorizationCode,
  NewOidcAuthorizationRequest,
  OidcAuthorizationCode,
  OidcAuthorizationRequest,
  OidcUserProfile,
};

export class OidcRepository {
  /**
   * Insert a pending authorization code. The `code_hash` primary key turns an
   * (astronomically unlikely) collision into a loud unique violation rather
   * than a silent overwrite of another user's pending authorization.
   */
  async insertCode(row: NewOidcAuthorizationCode): Promise<OidcAuthorizationCode> {
    const [inserted] = await dbWrite.insert(oidcAuthorizationCodes).values(row).returning();
    if (!inserted) {
      throw new Error("OidcRepository: failed to insert authorization code");
    }
    return inserted;
  }

  /** Atomically claim (and destroy) a live authorization code. */
  async claimCode(
    codeHash: string,
    now: Date = new Date(),
  ): Promise<OidcAuthorizationCode | undefined> {
    const [claimed] = await dbWrite
      .delete(oidcAuthorizationCodes)
      .where(
        and(
          eq(oidcAuthorizationCodes.code_hash, codeHash),
          gt(oidcAuthorizationCodes.expires_at, now),
        ),
      )
      .returning();
    return claimed;
  }

  /** Opportunistic cleanup of expired, never-redeemed codes (rows are ~60s-lived). */
  async purgeExpiredCodes(now: Date = new Date()): Promise<number> {
    const purged = await dbWrite
      .delete(oidcAuthorizationCodes)
      .where(lte(oidcAuthorizationCodes.expires_at, now))
      .returning({ code_hash: oidcAuthorizationCodes.code_hash });
    return purged.length;
  }

  async insertRequest(row: NewOidcAuthorizationRequest): Promise<OidcAuthorizationRequest> {
    const [inserted] = await dbWrite.insert(oidcAuthorizationRequests).values(row).returning();
    if (!inserted) {
      throw new Error("OidcRepository: failed to insert authorization request");
    }
    return inserted;
  }

  /** Atomically claim (and destroy) a parked authorization request. */
  async claimRequest(
    requestHash: string,
    now: Date = new Date(),
  ): Promise<OidcAuthorizationRequest | undefined> {
    const [claimed] = await dbWrite
      .delete(oidcAuthorizationRequests)
      .where(
        and(
          eq(oidcAuthorizationRequests.request_hash, requestHash),
          gt(oidcAuthorizationRequests.expires_at, now),
        ),
      )
      .returning();
    return claimed;
  }

  async purgeExpiredRequests(now: Date = new Date()): Promise<number> {
    const purged = await dbWrite
      .delete(oidcAuthorizationRequests)
      .where(lte(oidcAuthorizationRequests.expires_at, now))
      .returning({ request_hash: oidcAuthorizationRequests.request_hash });
    return purged.length;
  }

  async findProfile(userId: string): Promise<OidcUserProfile | undefined> {
    const [profile] = await dbRead
      .select()
      .from(oidcUserProfiles)
      .where(eq(oidcUserProfiles.user_id, userId))
      .limit(1);
    return profile;
  }

  /** Primary-DB read, used immediately after an allocation attempt. */
  async findProfileForWrite(userId: string): Promise<OidcUserProfile | undefined> {
    const [profile] = await dbWrite
      .select()
      .from(oidcUserProfiles)
      .where(eq(oidcUserProfiles.user_id, userId))
      .limit(1);
    return profile;
  }

  /**
   * Claim `username` for `userId`, or return undefined when either the name or
   * the user already has a row. `onConflictDoNothing` covers both unique
   * constraints in one statement, so a concurrent allocation of the same
   * candidate resolves without a transaction.
   */
  async allocateUsername(userId: string, username: string): Promise<OidcUserProfile | undefined> {
    const [inserted] = await dbWrite
      .insert(oidcUserProfiles)
      .values({ user_id: userId, username })
      .onConflictDoNothing()
      .returning();
    return inserted;
  }
}

export const oidcRepository = new OidcRepository();
