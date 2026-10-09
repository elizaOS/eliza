/** Resolves explicit native product selections against current registration, purchaser and developer billing authority. */
import type { AppBillingApplicationProduct } from "@elizaos/cloud-sdk/app-billing";
import { ElizaError } from "@elizaos/core";
import { and, eq, isNull } from "drizzle-orm";
import { writeTransaction } from "../helpers";
import { appBillingAccounts, appBillingScopes, billingMerchants } from "../schemas/app-billing";
import { appBillingApplicationSlots } from "../schemas/app-billing-application-slots";
import { apps } from "../schemas/apps";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";
import { lockAppBillingScope, requireAppBillingAdministrator } from "./app-subscription-authority";
import { readBillingIdentitySubject } from "./billing-identities";
import { readPostLockDatabaseNow } from "./primary-database-clock";

function unavailable(message: string): never {
  throw new ElizaError(message, { code: "APP_BILLING_APPLICATION_SLOT_UNAVAILABLE" });
}
export interface AppBillingApplicationSelection {
  slotId: string;
  appId: string;
  billingAccountId: string;
  scopeId: string;
  productFamilyKey: string;
  environment: "test" | "live";
  developerOrganizationId: string;
  actorUserId: string;
}
/** A selected but unavailable slot is a denial; callers must never fall back to prepaid dispatch. */
export async function resolveAppBillingApplicationSlot(input: {
  slotKey: string;
  livemode: boolean;
  verifiedUserId: string;
}): Promise<AppBillingApplicationSelection> {
  return writeTransaction(async (tx) => {
    const [slot] = await tx
      .select()
      .from(appBillingApplicationSlots)
      .where(
        and(
          eq(appBillingApplicationSlots.slot_key, input.slotKey),
          eq(appBillingApplicationSlots.livemode, input.livemode),
          isNull(appBillingApplicationSlots.disabled_at),
        ),
      );
    if (!slot) unavailable("Selected application product is not configured for this environment");
    const identity = await readBillingIdentitySubject(tx, input.verifiedUserId);
    if (!identity || identity.live_user_id !== input.verifiedUserId)
      unavailable("Selected application requires a current purchaser identity");
    const [account] = await tx
      .select()
      .from(appBillingAccounts)
      .where(
        and(
          eq(appBillingAccounts.app_id, slot.app_id),
          eq(appBillingAccounts.external_account_key, `user:${input.verifiedUserId}`),
          eq(appBillingAccounts.eligibility_principal_id, identity.eligibility_principal_id),
          isNull(appBillingAccounts.deleted_at),
        ),
      );
    if (!account) unavailable("Selected application requires its own purchaser account");
    const [candidate] = await tx
      .select({ id: appBillingScopes.id })
      .from(appBillingScopes)
      .where(
        and(
          eq(appBillingScopes.billing_account_id, account.id),
          eq(appBillingScopes.product_family_key, slot.product_family_key),
          eq(appBillingScopes.merchant_id, slot.merchant_id),
          eq(appBillingScopes.livemode, slot.livemode),
        ),
      );
    if (!candidate) unavailable("Selected application purchaser has no product billing scope");
    const scope = await lockAppBillingScope(tx, candidate.id, true);
    if (scope.fenced) unavailable("Selected application access is suspended");
    const [current] = await tx
      .select()
      .from(appBillingApplicationSlots)
      .where(eq(appBillingApplicationSlots.id, slot.id))
      .for("share");
    if (
      !current ||
      current.disabled_at !== null ||
      scope.organizationId !== slot.organization_id ||
      scope.appId !== slot.app_id
    )
      unavailable("Selected application product was disabled or changed ownership");
    const [user] = await tx
      .select({
        id: users.id,
        is_active: users.is_active,
        deleted_at: users.deleted_at,
        is_anonymous: users.is_anonymous,
        account_lifecycle_state: users.account_lifecycle_state,
        auth_fenced_at: users.auth_fenced_at,
        expires_at: users.expires_at,
      })
      .from(users)
      .where(eq(users.id, input.verifiedUserId))
      .for("update");
    const now = await readPostLockDatabaseNow(tx);
    if (
      !user ||
      !user.is_active ||
      user.deleted_at !== null ||
      user.is_anonymous ||
      user.account_lifecycle_state !== "active" ||
      user.auth_fenced_at !== null ||
      (user.expires_at !== null && user.expires_at <= now)
    )
      unavailable("Selected application requires a current verified native identity");
    await requireAppBillingAdministrator(tx, scope, user.id);
    return {
      slotId: slot.id,
      appId: slot.app_id,
      billingAccountId: account.id,
      scopeId: scope.scopeId,
      productFamilyKey: slot.product_family_key,
      environment: slot.livemode ? "live" : "test",
      developerOrganizationId: slot.organization_id,
      actorUserId: user.id,
    };
  });
}

/** This configuration read grants no access; purchase and inference revalidate their own current authority. */
export async function readAppBillingApplicationProduct(input: {
  slotKey: string;
  livemode: boolean;
}): Promise<AppBillingApplicationProduct> {
  return writeTransaction(async (tx) => {
    const [row] = await tx
      .select({
        slotKey: appBillingApplicationSlots.slot_key,
        appId: apps.id,
        appName: apps.name,
        productFamilyKey: appBillingApplicationSlots.product_family_key,
        livemode: appBillingApplicationSlots.livemode,
        organizationActive: organizations.is_active,
        organizationLifecycle: organizations.account_lifecycle_state,
        organizationFencedAt: organizations.paid_work_fenced_at,
        appActive: apps.is_active,
        appApproved: apps.is_approved,
        appReview: apps.review_status,
      })
      .from(appBillingApplicationSlots)
      .innerJoin(
        apps,
        and(
          eq(apps.id, appBillingApplicationSlots.app_id),
          eq(apps.organization_id, appBillingApplicationSlots.organization_id),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, appBillingApplicationSlots.organization_id))
      .innerJoin(
        billingMerchants,
        and(
          eq(billingMerchants.id, appBillingApplicationSlots.merchant_id),
          eq(billingMerchants.organization_id, appBillingApplicationSlots.organization_id),
          eq(billingMerchants.livemode, appBillingApplicationSlots.livemode),
        ),
      )
      .where(
        and(
          eq(appBillingApplicationSlots.slot_key, input.slotKey),
          eq(appBillingApplicationSlots.livemode, input.livemode),
          isNull(appBillingApplicationSlots.disabled_at),
        ),
      );
    if (
      !row ||
      !row.organizationActive ||
      row.organizationLifecycle !== "active" ||
      row.organizationFencedAt !== null ||
      !row.appActive ||
      !row.appApproved ||
      row.appReview !== "approved"
    )
      unavailable(
        "Selected application product billing is unavailable; no other billing source was selected",
      );
    return {
      slotKey: row.slotKey,
      appId: row.appId,
      appName: row.appName,
      productFamilyKey: row.productFamilyKey,
      environment: row.livemode ? "live" : "test",
    };
  });
}
