/**
 * Network membership writes: creating members and invites, and accepting an
 * invite on the first message from an invited phone (linking the member to the
 * Cloud account the inbound route just resolved). Every operation is a single
 * idempotent statement.
 */

import { sql } from "drizzle-orm";
import type { NetworkSqlExecutor } from "./member-store";

type Executor = NetworkSqlExecutor | (() => Promise<NetworkSqlExecutor>);

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inviteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export type NetworkInviteLinkResult =
  | { kind: "linked"; memberId: string; acceptedInvites: number; created: boolean }
  | { kind: "not_invited" }
  | { kind: "account_mismatch"; memberId: string };

export interface NetworkMembership {
  /** Idempotent on phone: re-running returns the same member and keeps existing fields. */
  upsertMember(input: {
    phoneE164: string;
    firstName?: string | null;
    city?: string | null;
    facets?: string[];
  }): Promise<{ memberId: string; created: boolean }>;
  /** Creates a pending invite and returns the one-time token (only its hash is stored). */
  createInvite(input: {
    phoneE164: string;
    invitedByMemberId?: string | null;
    expiresAt?: Date | null;
  }): Promise<{ inviteId: string; token: string }>;
  /**
   * First message from an invited phone: upsert the member for the phone, link
   * it to the resolved Cloud account, and accept every live invite for the
   * phone. Re-running for the same (phone, account) changes nothing. A phone
   * already linked to a different account is refused, never relinked.
   */
  linkInvitedPhone(input: {
    phoneE164: string;
    cloudUserId: string;
    organizationId: string;
  }): Promise<NetworkInviteLinkResult>;
}

export function createPostgresNetworkMembership(executor: Executor): NetworkMembership {
  const db = typeof executor === "function" ? executor : async () => executor;
  return {
    async upsertMember(input) {
      const [row] = rowsOf(
        await (await db()).execute(sql`
          INSERT INTO "network"."members" ("phone_e164", "first_name", "city", "facets")
          VALUES (${input.phoneE164}, ${input.firstName ?? null}, ${input.city ?? null},
                  ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.facets ?? [])}::jsonb)))
          ON CONFLICT ("phone_e164") DO UPDATE
             SET "first_name" = COALESCE("network"."members"."first_name", EXCLUDED."first_name"),
                 "city" = COALESCE("network"."members"."city", EXCLUDED."city")
          RETURNING "id", (xmax = 0) AS "created"
        `),
      );
      if (!row) throw new Error("Network member upsert returned no row");
      return { memberId: String(row.id), created: row.created === true || row.created === "t" };
    },

    async createInvite(input) {
      const token = inviteToken();
      const [row] = rowsOf(
        await (await db()).execute(sql`
          INSERT INTO "network"."invites" ("phone_e164", "token_hash", "invited_by_member_id", "expires_at")
          VALUES (${input.phoneE164}, ${await sha256Hex(token)},
                  ${input.invitedByMemberId ?? null}::uuid,
                  ${input.expiresAt ? input.expiresAt.toISOString() : null}::timestamptz)
          RETURNING "id"
        `),
      );
      if (!row) throw new Error("Network invite insert returned no row");
      return { inviteId: String(row.id), token };
    },

    async linkInvitedPhone(input) {
      // Admission: an accepted or live invite, or an existing non-removed
      // member. The member upsert links only an unlinked row; the invite update
      // accepts only live invites; both are no-ops on a replay.
      const [row] = rowsOf(
        await (await db()).execute(sql`
          WITH "admitted" AS (
            SELECT 1 FROM "network"."invites"
             WHERE "phone_e164" = ${input.phoneE164}
               AND ("status" = 'accepted'
                    OR ("status" = 'pending' AND ("expires_at" IS NULL OR "expires_at" > now())))
            UNION ALL
            SELECT 1 FROM "network"."members"
             WHERE "phone_e164" = ${input.phoneE164} AND "state" <> 'removed'
            LIMIT 1
          ), "member" AS (
            INSERT INTO "network"."members" ("phone_e164", "cloud_user_id", "organization_id")
            SELECT ${input.phoneE164}, ${input.cloudUserId}::uuid, ${input.organizationId}::uuid
             WHERE EXISTS (SELECT 1 FROM "admitted")
            ON CONFLICT ("phone_e164") DO UPDATE
               SET "cloud_user_id" = COALESCE("network"."members"."cloud_user_id", EXCLUDED."cloud_user_id"),
                   "organization_id" = COALESCE("network"."members"."organization_id", EXCLUDED."organization_id"),
                   "updated_at" = CASE WHEN "network"."members"."cloud_user_id" IS NULL
                                       THEN now() ELSE "network"."members"."updated_at" END
            RETURNING "id", "cloud_user_id", (xmax = 0) AS "created"
          ), "accepted" AS (
            UPDATE "network"."invites"
               SET "status" = 'accepted', "accepted_at" = now(),
                   "accepted_member_id" = (SELECT "id" FROM "member")
             WHERE "phone_e164" = ${input.phoneE164}
               AND "status" = 'pending'
               AND ("expires_at" IS NULL OR "expires_at" > now())
               AND (SELECT "cloud_user_id" FROM "member") = ${input.cloudUserId}::uuid
            RETURNING "id"
          )
          SELECT "member"."id", "member"."cloud_user_id"::text AS "cloud_user_id",
                 "member"."created", (SELECT count(*) FROM "accepted") AS "accepted"
            FROM "member"
        `),
      );
      if (!row) return { kind: "not_invited" };
      const memberId = String(row.id);
      if (String(row.cloud_user_id) !== input.cloudUserId) {
        return { kind: "account_mismatch", memberId };
      }
      return {
        kind: "linked",
        memberId,
        acceptedInvites: Number(row.accepted),
        created: row.created === true || row.created === "t",
      };
    },
  };
}

/** Production membership over Cloud's write connection (lazy import). */
export const networkMembership: NetworkMembership = createPostgresNetworkMembership(
  async () => (await import("../../db/client")).dbWrite as unknown as NetworkSqlExecutor,
);
