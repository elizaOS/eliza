/** Primary consent authorization and callback-owned atomic preference updates. */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type GooglePersonalContextConsent,
  isGooglePersonalContextConsent,
  selectedGoogleContextConsent,
} from "../../lib/services/shared-runtime/shared-google-consent";
import { type Database, type DbTransaction, dbWrite } from "../client";
import { organizations } from "../schemas/organizations";
import { platformCredentials } from "../schemas/platform-credentials";
import { users } from "../schemas/users";

type PersonalGoogleOwnerScope = { organizationId: string; userId: string };

function personalGoogleOwnerQuery(
  executor: Pick<Database, "select">,
  args: PersonalGoogleOwnerScope,
) {
  return executor
    .select({ user: users })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organization_id))
    .where(
      and(
        eq(users.id, args.userId),
        eq(users.organization_id, args.organizationId),
        eq(users.is_active, true),
        isNull(users.deleted_at),
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.account_deletion_request_id),
      ),
    );
}

/** Primary authorization read; cached user/profile snapshots cannot grant private context. */
export async function readPersonalGoogleContextOwner(args: PersonalGoogleOwnerScope) {
  const [row] = await personalGoogleOwnerQuery(dbWrite, args).limit(1);
  return row?.user;
}

/** Lock both owner and organization lifecycle until grant and consent publication commits. */
export async function lockPersonalGoogleContextOwner(
  tx: DbTransaction,
  args: PersonalGoogleOwnerScope,
) {
  const [row] = await personalGoogleOwnerQuery(tx, args).for("update").limit(1);
  if (!row) throw new Error("GOOGLE_PERSONAL_CONTEXT_OWNER_CHANGED");
  return row.user;
}

/** Recheck selected consent and exact active grant before every private token use. */
export async function authorizePersonalGoogleContextRead(args: {
  organizationId: string;
  userId: string;
  grantId: string;
}) {
  const requiredScopes = JSON.stringify([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);
  const [row] = await dbWrite
    .select({ user: users })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organization_id))
    .innerJoin(
      platformCredentials,
      and(
        eq(platformCredentials.id, args.grantId),
        eq(platformCredentials.user_id, users.id),
        eq(platformCredentials.organization_id, users.organization_id),
        eq(platformCredentials.platform, "google"),
        eq(platformCredentials.status, "active"),
        sql`upper(COALESCE(${platformCredentials.source_context}->>'connectionRole', 'OWNER')) = 'OWNER'`,
        sql`${platformCredentials.scopes} @> ${requiredScopes}::jsonb`,
      ),
    )
    .where(
      and(
        eq(users.id, args.userId),
        eq(users.organization_id, args.organizationId),
        eq(users.is_active, true),
        isNull(users.deleted_at),
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.account_deletion_request_id),
      ),
    )
    .limit(1);
  const consent = row && selectedGoogleContextConsent(row.user.preferences);
  return consent?.grantId === args.grantId;
}

export async function bindPersonalGoogleContextConsent(
  args: {
    organizationId: string;
    userId: string;
    grantId: string;
    consent: GooglePersonalContextConsent;
  },
  executor: Pick<DbTransaction, "update"> = dbWrite,
) {
  if (!isGooglePersonalContextConsent(args.consent))
    throw new Error("GOOGLE_PERSONAL_CONTEXT_CONSENT_INVALID");
  const value = JSON.stringify({
    ...args.consent,
    grantId: args.grantId,
    authorizedAt: new Date().toISOString(),
  });
  const requiredScopes = JSON.stringify([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
  ]);
  const [updated] = await executor
    .update(users)
    .set({
      preferences: sql`(COALESCE(NULLIF(${users.preferences}, ''), '{}')::jsonb
      || jsonb_build_object('personalGoogleContext', ${value}::jsonb))::text`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(users.id, args.userId),
        eq(users.organization_id, args.organizationId),
        eq(users.is_active, true),
        sql`${users.deleted_at} IS NULL`,
        sql`EXISTS (SELECT 1 FROM ${organizations} owner_org WHERE owner_org.id = ${args.organizationId}::uuid AND owner_org.is_active = TRUE
        AND owner_org.account_lifecycle_state = 'active'
        AND owner_org.account_deletion_request_id IS NULL)`,
        sql`jsonb_typeof(COALESCE(NULLIF(${users.preferences}, ''), '{}')::jsonb) = 'object'`,
        sql`EXISTS (SELECT 1 FROM ${platformCredentials} grant_row
      WHERE grant_row.id = ${args.grantId}::uuid
        AND grant_row.organization_id = ${args.organizationId}::uuid
        AND grant_row.user_id = ${args.userId}::uuid
        AND grant_row.platform = 'google' AND grant_row.status = 'active'
        AND upper(COALESCE(grant_row.source_context->>'connectionRole', 'OWNER')) = 'OWNER'
        AND grant_row.scopes @> ${requiredScopes}::jsonb)`,
      ),
    )
    .returning();
  if (!updated) throw new Error("GOOGLE_PERSONAL_CONTEXT_OWNER_OR_GRANT_CHANGED");
  return updated;
}

export async function clearPersonalGoogleContextConsent(args: {
  organizationId: string;
  grantId: string;
}) {
  const [updated] = await dbWrite
    .update(users)
    .set({
      preferences: sql`(${users.preferences}::jsonb - 'personalGoogleContext')::text`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(users.organization_id, args.organizationId),
        sql`${users.preferences}::jsonb->'personalGoogleContext'->>'grantId' = ${args.grantId}`,
        sql`EXISTS (SELECT 1 FROM ${platformCredentials} revoked_grant
      WHERE revoked_grant.id = ${args.grantId}::uuid
        AND revoked_grant.organization_id = ${args.organizationId}::uuid
        AND revoked_grant.user_id = ${users.id} AND revoked_grant.platform = 'google'
        AND revoked_grant.status = 'revoked')`,
      ),
    )
    .returning();
  return updated;
}
