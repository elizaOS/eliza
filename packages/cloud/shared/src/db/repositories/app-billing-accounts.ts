/** Registers unconfigured app billing contracts and reads individual consent-bound accounts from primary storage. Infrastructure payer provenance comes exclusively from the registered app owner. */

import type {
  AppBillingAccountDto,
  AppBillingEnvironment,
  AppBillingRegistrationDto,
} from "@elizaos/cloud-sdk/app-billing-account";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { sqlRows } from "../execute-helpers";
import { dbWrite, writeTransaction } from "../helpers";
import { apiKeys } from "../schemas/api-keys";
import { appBillingRegistrations } from "../schemas/app-billing-accounts";
import { apps } from "../schemas/apps";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export type AppBillingPrincipal = { userId: string; credentialId: string | null };
function denied(): never {
  throw new ElizaError("App billing authority is not available to this principal", {
    code: "APP_BILLING_ACCESS_DENIED",
  });
}
function dto(row: typeof appBillingRegistrations.$inferSelect): AppBillingRegistrationDto {
  return {
    id: row.id,
    appId: row.app_id,
    environment: row.provider_environment,
    merchant: { state: row.merchant_state },
    policy: { state: row.policy_state },
  };
}

/** The caller must hold the app row lock before changing consent or registration. */
export async function materializeAppBillingAccounts(
  tx: DbTransaction,
  appId: string,
): Promise<void> {
  await tx.execute(sql`INSERT INTO app_subscriber_accounts(registration_id, app_id, subscriber_user_id)
    SELECT r.id, r.app_id, c.user_id FROM app_billing_registrations r
    JOIN app_users c ON c.app_id = r.app_id WHERE r.app_id = ${appId}::uuid AND c.signup_source = 'oauth'
    ON CONFLICT (registration_id, subscriber_user_id) DO NOTHING`);
}

async function checkPrincipal(tx: DbTransaction, appId: string, principal: AppBillingPrincipal) {
  const [user] = await tx
    .select({ id: users.id, organizationId: users.organization_id })
    .from(users)
    .innerJoin(organizations, eq(users.organization_id, organizations.id))
    .where(
      and(
        eq(users.id, principal.userId),
        eq(users.is_active, true),
        eq(organizations.is_active, true),
        eq(organizations.account_lifecycle_state, "active"),
        isNull(organizations.paid_work_fenced_at),
        isNull(organizations.account_deletion_request_id),
      ),
    )
    .limit(1);
  if (!user) denied();
  if (principal.credentialId !== null) {
    const [credential] = await tx
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.id, principal.credentialId),
          eq(apiKeys.user_id, user.id),
          eq(apiKeys.organization_id, user.organizationId!),
          eq(apiKeys.source_app_id, appId),
          eq(apiKeys.is_active, true),
          isNull(apiKeys.deleted_at),
          sql`(${apiKeys.expires_at} IS NULL OR ${apiKeys.expires_at} > clock_timestamp())`,
        ),
      )
      .limit(1);
    if (!credential) denied();
  }
  return user;
}

export class AppBillingAccountsRepository {
  async register(
    appId: string,
    environment: AppBillingEnvironment,
    principal: AppBillingPrincipal,
  ): Promise<AppBillingRegistrationDto> {
    if (principal.credentialId !== null) denied();
    return writeTransaction(async (tx) => {
      const [app] = await tx
        .select({
          id: apps.id,
          organizationId: apps.organization_id,
          creatorId: apps.created_by_user_id,
        })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.is_active, true), eq(apps.is_approved, true)))
        .limit(1)
        .for("update");
      if (!app) denied();
      const user = await checkPrincipal(tx, appId, principal);
      if (app.creatorId !== user.id || app.organizationId !== user.organizationId) denied();
      await tx
        .insert(appBillingRegistrations)
        .values({
          app_id: appId,
          owner_organization_id: app.organizationId,
          infrastructure_payer_organization_id: app.organizationId,
          registered_by_user_id: user.id,
          provider_environment: environment,
        })
        .onConflictDoNothing();
      const [registration] = await tx
        .select()
        .from(appBillingRegistrations)
        .where(
          and(
            eq(appBillingRegistrations.app_id, appId),
            eq(appBillingRegistrations.provider_environment, environment),
          ),
        )
        .limit(1);
      if (
        !registration ||
        registration.owner_organization_id !== app.organizationId ||
        registration.registered_by_user_id !== user.id
      )
        denied();
      await materializeAppBillingAccounts(tx, appId);
      return dto(registration);
    });
  }

  async read(
    appId: string,
    environment: AppBillingEnvironment,
    principal: AppBillingPrincipal,
  ): Promise<AppBillingAccountDto> {
    // One primary statement observes credential, consent, app and account fences together.
    const credential =
      principal.credentialId === null
        ? sql`TRUE`
        : sql`EXISTS (
      SELECT 1 FROM api_keys k WHERE k.id = ${principal.credentialId}::uuid
        AND k.user_id = u.id AND k.organization_id = u.organization_id AND k.source_app_id = a.id
        AND k.is_active AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > clock_timestamp())
    )`;
    const [row] = await sqlRows<{ registration_id: string | null; account_id: string | null }>(
      dbWrite,
      sql`
      SELECT r.id AS registration_id, b.id AS account_id
      FROM apps a JOIN organizations owner_org ON owner_org.id = a.organization_id
      JOIN app_users consent ON consent.app_id = a.id AND consent.user_id = ${principal.userId}::uuid AND consent.signup_source = 'oauth'
      JOIN users u ON u.id = consent.user_id JOIN organizations user_org ON user_org.id = u.organization_id
      LEFT JOIN app_billing_registrations r ON r.app_id = a.id AND r.provider_environment = ${environment}
      LEFT JOIN app_subscriber_accounts b ON b.registration_id = r.id AND b.app_id = a.id AND b.subscriber_user_id = u.id
      WHERE a.id = ${appId}::uuid AND a.is_active AND a.is_approved AND u.is_active
        AND owner_org.is_active AND owner_org.account_lifecycle_state = 'active' AND owner_org.paid_work_fenced_at IS NULL AND owner_org.account_deletion_request_id IS NULL
        AND user_org.is_active AND user_org.account_lifecycle_state = 'active' AND user_org.paid_work_fenced_at IS NULL AND user_org.account_deletion_request_id IS NULL
        AND ${credential}
    `,
    );
    if (!row) denied();
    if (row.registration_id === null) return { state: "unregistered", appId, environment };
    if (row.account_id === null)
      throw new ElizaError("Consented app billing account has not been materialized", {
        code: "APP_BILLING_ACCOUNT_UNAVAILABLE",
      });
    return {
      state: "unconfigured",
      registration: {
        id: row.registration_id,
        appId,
        environment,
        merchant: { state: "unconfigured" },
        policy: { state: "unconfigured" },
      },
      account: { id: row.account_id, kind: "individual" },
      subscription: { state: "unavailable", reason: "merchant_and_policy_unconfigured" },
    };
  }
}
export const appBillingAccountsRepository = new AppBillingAccountsRepository();
