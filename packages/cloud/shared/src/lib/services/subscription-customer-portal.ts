/**
 * Opens the Stripe Customer Portal for an organization's own Plus/Pro subscription customer.
 * The customer comes only from the primary database, the return URL only from server config,
 * and the portal configuration is locked: no plan switching, cancellation only at period end.
 */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { subscriptionCheckoutRecoveryRepository } from "../../db/repositories/subscription-checkout-recovery";
import { isProductionDeployment } from "../config/deployment-environment";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import { assertCheckoutProviderMode } from "./subscription-checkout-contract";

/** Metadata marker that identifies the one portal configuration this service owns. */
export const SUBSCRIPTION_PORTAL_CONFIGURATION_KEY = "eliza_cloud_portal_configuration";
export const SUBSCRIPTION_PORTAL_CONFIGURATION_VERSION = "org-subscription-v1";
export const SUBSCRIPTION_PORTAL_RETURN_PATH = "/cloud/billing";

export const LOCKED_SUBSCRIPTION_PORTAL_FEATURES = {
  customer_update: { enabled: false },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
  subscription_update: { enabled: false },
} as const satisfies Stripe.BillingPortal.ConfigurationCreateParams.Features;

function unavailable(reason: string): never {
  throw new ElizaError("Billing portal is temporarily unavailable", {
    code: "SUBSCRIPTION_PORTAL_UNAVAILABLE",
    context: { reason },
  });
}

function notApplicable(reason: string): never {
  throw new ElizaError("This account has no subscription billing to manage", {
    code: "SUBSCRIPTION_PORTAL_NOT_APPLICABLE",
    context: { reason },
  });
}

/** True only when a configuration exposes exactly the locked organization policy. */
export function isLockedSubscriptionPortalConfiguration(
  configuration: Stripe.BillingPortal.Configuration,
  expectedLivemode: boolean,
): boolean {
  const features = configuration.features;
  const pause = (features as { subscription_pause?: { enabled?: boolean } }).subscription_pause;
  return (
    configuration.active &&
    configuration.livemode === expectedLivemode &&
    configuration.metadata?.[SUBSCRIPTION_PORTAL_CONFIGURATION_KEY] ===
      SUBSCRIPTION_PORTAL_CONFIGURATION_VERSION &&
    features.customer_update.enabled === false &&
    features.invoice_history.enabled === true &&
    features.payment_method_update.enabled === true &&
    features.subscription_cancel.enabled === true &&
    features.subscription_cancel.mode === "at_period_end" &&
    features.subscription_update.enabled === false &&
    pause?.enabled !== true
  );
}

/**
 * Finds the owned configuration by metadata, re-locks it if it drifted, and otherwise creates it
 * under an account-scoped idempotency key so concurrent first uses converge on one object.
 */
async function ensurePortalConfiguration(
  stripe: Stripe,
  accountId: string,
  expectedLivemode: boolean,
): Promise<Stripe.BillingPortal.Configuration> {
  const lockedParams = {
    business_profile: { headline: "Manage your Eliza Cloud subscription billing." },
    features: LOCKED_SUBSCRIPTION_PORTAL_FEATURES,
    metadata: {
      [SUBSCRIPTION_PORTAL_CONFIGURATION_KEY]: SUBSCRIPTION_PORTAL_CONFIGURATION_VERSION,
    },
  } satisfies Stripe.BillingPortal.ConfigurationCreateParams;
  let owned: Stripe.BillingPortal.Configuration | undefined;
  for await (const candidate of stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  })) {
    if (
      candidate.metadata?.[SUBSCRIPTION_PORTAL_CONFIGURATION_KEY] ===
      SUBSCRIPTION_PORTAL_CONFIGURATION_VERSION
    ) {
      owned = candidate;
      break;
    }
  }
  if (owned && !isLockedSubscriptionPortalConfiguration(owned, expectedLivemode)) {
    owned = await stripe.billingPortal.configurations.update(owned.id, lockedParams);
  }
  if (!owned) {
    owned = await stripe.billingPortal.configurations.create(lockedParams, {
      idempotencyKey: `eliza-portal-configuration-${SUBSCRIPTION_PORTAL_CONFIGURATION_VERSION}-${accountId}`,
    });
  }
  if (!isLockedSubscriptionPortalConfiguration(owned, expectedLivemode))
    unavailable("portal_configuration_unlocked");
  return owned;
}

export async function createSubscriptionPortalSession(
  input: { organizationId: string },
  reauthorize: () => Promise<void>,
): Promise<{ url: string }> {
  const env = getCloudAwareEnv();
  const appUrl = env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) unavailable("missing_app_origin");
  const origin = new URL(appUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password)
    unavailable("invalid_app_origin");
  const expectedLivemode = isProductionDeployment(env);
  assertCheckoutProviderMode(expectedLivemode, env);
  await reauthorize();
  const authority = await subscriptionCheckoutRecoveryRepository.readPortalAuthority(
    input.organizationId,
  );
  if (!authority) notApplicable("no_stripe_subscription_customer");
  const stripe = requireStripe();
  const account = await stripe.accounts.retrieve(null);
  const configuration = await ensurePortalConfiguration(stripe, account.id, expectedLivemode);
  await reauthorize();
  const session = await stripe.billingPortal.sessions.create({
    customer: authority.customerId,
    configuration: configuration.id,
    return_url: `${origin.origin}${SUBSCRIPTION_PORTAL_RETURN_PATH}`,
  });
  const sessionConfiguration =
    typeof session.configuration === "string" ? session.configuration : session.configuration?.id;
  if (
    session.customer !== authority.customerId ||
    session.livemode !== expectedLivemode ||
    sessionConfiguration !== configuration.id
  )
    unavailable("portal_session_identity_mismatch");
  const url = URL.canParse(session.url) ? new URL(session.url) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.hostname !== "billing.stripe.com" ||
    url.username ||
    url.password
  )
    unavailable("invalid_portal_url");
  return { url: url.href };
}
