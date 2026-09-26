/** Installs reviewed native application selections and verifies the configured merchant before enabling product routing. */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { writeTransaction } from "../../db/helpers";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import { appBillingPlanRevisions, billingMerchants } from "../../db/schemas/app-billing";
import { appBillingApplicationSlots } from "../../db/schemas/app-billing-application-slots";
import { apps } from "../../db/schemas/apps";
import { organizations } from "../../db/schemas/organizations";
import {
  type AppBillingSlotManifest,
  appBillingSlotManifestSchema,
} from "./generic-billing-import-manifest";
import { createGenericBillingProvider } from "./generic-billing-provider";
import { appBillingProviderMerchant, getAppBillingStripe } from "./generic-billing-runtime-config";

export async function installAppBillingApplicationSlot(
  input: { manifest: AppBillingSlotManifest; digest: string },
  stripeForMode: (livemode: boolean) => Promise<Stripe> = getAppBillingStripe,
) {
  const manifest = appBillingSlotManifestSchema.parse(input.manifest);
  if (!/^[0-9a-f]{64}$/u.test(input.digest))
    appBillingConflict("Reviewed application manifest digest is invalid");
  const source = await writeTransaction(async (tx) => {
    const [merchant] = await tx
      .select()
      .from(billingMerchants)
      .where(
        and(
          eq(billingMerchants.id, manifest.merchantId),
          eq(billingMerchants.organization_id, manifest.developerOrganizationId),
          eq(billingMerchants.livemode, manifest.livemode),
        ),
      );
    if (!merchant) appBillingConflict("Application manifest merchant ownership or mode is invalid");
    const plans = await tx
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(
          eq(appBillingPlanRevisions.app_id, manifest.appId),
          eq(appBillingPlanRevisions.merchant_id, manifest.merchantId),
          eq(appBillingPlanRevisions.product_family_key, manifest.productFamilyKey),
          isNotNull(appBillingPlanRevisions.published_at),
          isNull(appBillingPlanRevisions.retired_at),
        ),
      );
    if (!plans.length)
      appBillingConflict("Application manifest requires a published catalog family");
    return { merchant, plans };
  });
  const provider = createGenericBillingProvider(
    await stripeForMode(manifest.livemode),
    appBillingProviderMerchant(source.merchant),
  );
  const observed = await provider.verifyMerchant();
  if (
    !observed.value.chargesEnabled ||
    !observed.value.payoutsEnabled ||
    !observed.value.cardPaymentsActive ||
    observed.value.disabledReason !== null
  )
    appBillingConflict("Application product merchant cannot accept subscriptions");
  for (const plan of source.plans)
    await provider.verifyPlan({
      planRevisionId: plan.id,
      priceId: plan.stripe_price_id,
      productId: plan.stripe_product_id,
      amountCents: plan.amount_cents,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.interval_count,
      minimumQuantity: plan.minimum_quantity,
      maximumQuantity: plan.maximum_quantity,
      trialDays: 7,
    });
  return writeTransaction(async (tx) => {
    const [organization] = await tx
      .select({
        is_active: organizations.is_active,
        account_lifecycle_state: organizations.account_lifecycle_state,
        paid_work_fenced_at: organizations.paid_work_fenced_at,
      })
      .from(organizations)
      .where(eq(organizations.id, manifest.developerOrganizationId))
      .for("update");
    const [app] = await tx
      .select({
        is_active: apps.is_active,
        is_approved: apps.is_approved,
        review_status: apps.review_status,
        organization_id: apps.organization_id,
      })
      .from(apps)
      .where(eq(apps.id, manifest.appId))
      .for("share");
    const [merchant] = await tx
      .select()
      .from(billingMerchants)
      .where(eq(billingMerchants.id, manifest.merchantId))
      .for("share");
    if (
      !organization?.is_active ||
      organization.account_lifecycle_state !== "active" ||
      organization.paid_work_fenced_at !== null ||
      !app?.is_active ||
      !app.is_approved ||
      app.review_status !== "approved" ||
      app.organization_id !== manifest.developerOrganizationId ||
      !merchant?.enabled ||
      merchant.connection_revision !== source.merchant.connection_revision
    )
      appBillingConflict("Application product was fenced or changed during provider verification");
    const [prior] = await tx
      .select()
      .from(appBillingApplicationSlots)
      .where(eq(appBillingApplicationSlots.manifest_digest, input.digest));
    if (prior) {
      if (
        prior.slot_key !== manifest.slotKey ||
        prior.app_id !== manifest.appId ||
        prior.organization_id !== manifest.developerOrganizationId ||
        prior.merchant_id !== manifest.merchantId ||
        prior.livemode !== manifest.livemode ||
        prior.product_family_key !== manifest.productFamilyKey
      )
        appBillingConflict("Application manifest replay changes its original binding");
      return prior;
    }
    const [row] = await tx
      .insert(appBillingApplicationSlots)
      .values({
        slot_key: manifest.slotKey,
        app_id: manifest.appId,
        organization_id: manifest.developerOrganizationId,
        merchant_id: manifest.merchantId,
        livemode: manifest.livemode,
        product_family_key: manifest.productFamilyKey,
        manifest_digest: input.digest,
      })
      .returning();
    if (!row) appBillingConflict("Application product slot was not persisted");
    return row;
  });
}
