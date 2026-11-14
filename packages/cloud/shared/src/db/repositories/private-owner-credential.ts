/** Primary credential attribution for private owner surfaces; never use auth/app caches. */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { dbWrite } from "../client";
import { apiKeys } from "../schemas/api-keys";
import { apps } from "../schemas/apps";
import { mobileAppAuthGrants } from "../schemas/mobile-app-auth-grants";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

function activeOwnerConditions(args: { userId: string; organizationId: string }) {
  return and(
    eq(users.id, args.userId),
    eq(users.organization_id, args.organizationId),
    eq(users.is_active, true),
    isNull(users.deleted_at),
    eq(users.account_lifecycle_state, "active"),
    isNull(users.account_deletion_request_id),
    or(isNull(users.expires_at), gt(users.expires_at, new Date())),
    eq(organizations.is_active, true),
    eq(organizations.account_lifecycle_state, "active"),
    isNull(organizations.account_deletion_request_id),
  );
}

export async function readPrivateOwnerAccountAuthority(args: {
  userId: string;
  organizationId: string;
}) {
  const [row] = await dbWrite
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organization_id))
    .where(activeOwnerConditions(args))
    .limit(1);
  return row;
}

export async function readPrivateOwnerApiKeyAuthority(args: {
  apiKeyId: string;
  apiKeyHash: string;
  userId: string;
  organizationId: string;
}) {
  const mobileApp = alias(apps, "private_owner_mobile_app");
  return dbWrite
    .select({
      key: {
        id: apiKeys.id,
        sourceAppId: apiKeys.source_app_id,
        active: apiKeys.is_active,
        deletedAt: apiKeys.deleted_at,
        expiresAt: apiKeys.expires_at,
      },
      backendAppId: apps.id,
      grant: {
        credentialId: mobileAppAuthGrants.credential_id,
        appId: mobileAppAuthGrants.app_id,
        userId: mobileAppAuthGrants.user_id,
        organizationId: mobileAppAuthGrants.organization_id,
        clientId: mobileAppAuthGrants.client_id,
        environment: mobileAppAuthGrants.environment,
        redirectUri: mobileAppAuthGrants.redirect_uri,
        scopes: mobileAppAuthGrants.scopes,
        status: mobileAppAuthGrants.status,
        acknowledgedAt: mobileAppAuthGrants.acknowledged_at,
      },
      mobileApp: { active: mobileApp.is_active, approved: mobileApp.is_approved },
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.user_id))
    .innerJoin(organizations, eq(organizations.id, users.organization_id))
    .leftJoin(apps, eq(apps.api_key_id, apiKeys.id))
    .leftJoin(mobileAppAuthGrants, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
    .leftJoin(mobileApp, eq(mobileApp.id, mobileAppAuthGrants.app_id))
    .where(
      and(
        eq(apiKeys.id, args.apiKeyId),
        eq(apiKeys.key_hash, args.apiKeyHash),
        eq(apiKeys.user_id, args.userId),
        eq(apiKeys.organization_id, args.organizationId),
        activeOwnerConditions(args),
      ),
    )
    .limit(2);
}
