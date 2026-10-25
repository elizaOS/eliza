/** Records reviewed migration intent in the existing command authority before provider verification or trial adoption. */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  type AppBillingImportManifest,
  appBillingImportManifestSchema,
} from "../../lib/services/generic-billing-import-manifest";
import { writeTransaction } from "../helpers";
import { appBillingPlanRevisions } from "../schemas/app-billing";
import { billingSubscriptions } from "../schemas/billing-subscriptions";
import { billingSubscriptionCommands } from "../schemas/subscription-billing-operations";
import { requireImportPrincipal } from "./app-billing-import-finalizer";
import {
  appBillingConflict,
  lockAppBillingScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { ensureBillingIdentitySubject } from "./billing-identities";
import { readPostLockDatabaseNow } from "./primary-database-clock";
export async function prepareAppBillingImport(input: {
  manifest: AppBillingImportManifest;
  digest: string;
}) {
  const manifest = appBillingImportManifestSchema.parse(input.manifest);
  if (!/^[0-9a-f]{64}$/u.test(input.digest))
    appBillingConflict("Reviewed billing import digest is invalid");
  return writeTransaction(async (tx) => {
    const scope = await lockAppBillingScope(tx, manifest.scopeId, true);
    await requireAppBillingAdministrator(tx, scope, manifest.principalUserId);
    await requireImportPrincipal(tx, manifest.principalUserId, await readPostLockDatabaseNow(tx));
    const identity = await ensureBillingIdentitySubject(tx, manifest.principalUserId);
    if (scope.eligibilityPrincipalId !== identity.eligibility_principal_id)
      appBillingConflict("Imported principal must match the existing canonical purchaser account");
    const [prior] = await tx
      .select()
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
          eq(billingSubscriptionCommands.idempotency_key, `import:${input.digest}`),
        ),
      )
      .for("update");
    if (prior) {
      if (prior.request_digest !== input.digest || prior.request_payload?.domain !== "operator")
        appBillingConflict("Import replay changes its original command");
      return prior;
    }
    const [plan] = await tx
      .select()
      .from(appBillingPlanRevisions)
      .where(
        and(
          eq(appBillingPlanRevisions.id, manifest.planRevisionId),
          eq(appBillingPlanRevisions.app_id, scope.appId),
          eq(appBillingPlanRevisions.merchant_id, scope.merchantId),
          eq(appBillingPlanRevisions.product_family_key, scope.productFamilyKey),
        ),
      );
    if (
      !plan?.published_at ||
      manifest.quantity < plan.minimum_quantity ||
      manifest.quantity > plan.maximum_quantity
    )
      appBillingConflict("Import plan and quantity must match the original registered product");
    if (manifest.provider) {
      const [source] = await tx
        .select()
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.merchant_key, scope.merchantKey),
            eq(billingSubscriptions.provider_environment, scope.livemode ? "live" : "test"),
            eq(billingSubscriptions.stripe_subscription_id, manifest.provider.subscriptionId),
          ),
        );
      if (source)
        appBillingConflict(
          source.billing_scope_id === null
            ? "Historical organization subscription requires explicit authority cutover; its original records and cash were preserved"
            : "Provider subscription already belongs to a canonical billing scope",
        );
    }
    const [existing] = await tx
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.billing_scope_id, scope.scopeId));
    if (existing) appBillingConflict("Import requires an empty canonical subscription scope");
    const [pending] = await tx
      .select({ id: billingSubscriptionCommands.id })
      .from(billingSubscriptionCommands)
      .where(
        and(
          eq(billingSubscriptionCommands.billing_scope_id, scope.scopeId),
          isNull(billingSubscriptionCommands.completed_at),
        ),
      );
    if (pending)
      appBillingConflict("Billing scope has an unfinished operation; reconcile it before import");
    const id = randomUUID();
    const [command] = await tx
      .insert(billingSubscriptionCommands)
      .values({
        id,
        app_id: scope.appId,
        livemode: scope.livemode,
        merchant_id: scope.merchantId,
        billing_scope_id: scope.scopeId,
        merchant_key: scope.merchantKey,
        organization_id: scope.organizationId,
        requested_by_user_id: manifest.principalUserId,
        kind: "import",
        target_quantity: manifest.quantity,
        target_plan_revision_id: plan.id,
        target_plan_key: plan.plan_key,
        idempotency_key: `import:${input.digest}`,
        provider_idempotency_key: `import:${id}`,
        request_digest: input.digest,
        request_payload: {
          version: 1,
          domain: "operator",
          action: "import",
          manifestDigest: input.digest,
          manifest,
        },
      })
      .returning();
    if (!command) appBillingConflict("Billing import intent was not persisted");
    return command;
  });
}
