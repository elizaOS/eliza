/** Runs operator-reviewed historical imports through durable leases, current Stripe reads and the canonical atomic finalizer. */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { dbWrite } from "../../db/helpers";
import { appBillingCommandRuntimeRepository } from "../../db/repositories/app-billing-command-runtime";
import { prepareAppBillingImport } from "../../db/repositories/app-billing-import";
import { finalizeAppBillingImport } from "../../db/repositories/app-billing-import-finalizer";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import { billingMerchants } from "../../db/schemas/app-billing";
import type { AppBillingImportManifest } from "./generic-billing-import-manifest";
import { verifyAppBillingImportProvider } from "./generic-billing-import-provider";
import { appBillingProviderMerchant, getAppBillingStripe } from "./generic-billing-runtime-config";

export async function importAppBillingHistory(
  input: { manifest: AppBillingImportManifest; digest: string },
  stripeForMode: (livemode: boolean) => Promise<Stripe> = getAppBillingStripe,
) {
  const prepared = await prepareAppBillingImport(input);
  if (prepared.status === "APPLIED" && prepared.provider_result?.kind === "import")
    return { commandId: prepared.id, status: "applied" as const, result: prepared.provider_result };
  const claimed = await appBillingCommandRuntimeRepository.claim({
    scopeId: input.manifest.scopeId,
    commandId: prepared.id,
    actorUserId: input.manifest.principalUserId,
  });
  if (!claimed) return { commandId: prepared.id, status: "pending" as const, result: null };
  try {
    if (claimed.command.request_payload?.domain !== "operator" || !claimed.plan)
      appBillingConflict("Import command lost its reviewed manifest or plan");
    const [merchant] = await dbWrite
      .select()
      .from(billingMerchants)
      .where(eq(billingMerchants.id, claimed.scope.merchantId));
    if (!merchant) appBillingConflict("Historical import merchant is unavailable");
    const plan = claimed.plan;
    const verified = await verifyAppBillingImportProvider({
      stripe: await stripeForMode(claimed.scope.livemode),
      merchant: appBillingProviderMerchant(merchant),
      scope: claimed.scope,
      plan: {
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
      },
      manifest: claimed.command.request_payload.manifest,
    });
    const result = await finalizeAppBillingImport({
      lease: claimed.lease,
      merchantRevision: merchant.connection_revision,
      verified,
    });
    return { commandId: prepared.id, status: "applied" as const, result };
  } catch (error) {
    // error-policy:J2 Preserve failed verification while making the same immutable import eligible for read-only recovery.
    await appBillingCommandRuntimeRepository.releaseLease(claimed.lease);
    throw error;
  }
}
