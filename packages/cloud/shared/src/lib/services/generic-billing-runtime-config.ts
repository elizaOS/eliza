/** Selects server-owned app billing credentials and validates their actual Stripe mode before dispatch. */
import { ElizaError } from "@elizaos/core";
import Stripe from "stripe";
import { z } from "zod";
import { isProductionDeployment } from "../config/deployment-environment";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { requireStripe } from "../stripe";
import {
  type BillingProviderMerchant,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "./generic-billing-provider-types";

export interface AppBillingRuntimeEnvironment {
  APP_BILLING_ENVIRONMENT?: string;
  APP_BILLING_UI_ORIGIN?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  STRIPE_TEST_SECRET_KEY?: string;
}
interface AppBillingStripeDependencies {
  environment(): AppBillingRuntimeEnvironment;
  deploymentStripe(): Stripe;
  testStripe(secretKey: string): Stripe;
}
function fail(code: string, message: string): never {
  throw new ElizaError(message, { code: `APP_BILLING_${code}` });
}
export function configuredAppBillingEnvironment(
  env: AppBillingRuntimeEnvironment = getCloudAwareEnv(),
): "test" | "live" {
  const configured = env.APP_BILLING_ENVIRONMENT;
  if (configured !== "test" && configured !== "live")
    fail(
      "ENVIRONMENT_UNCONFIGURED",
      "Set APP_BILLING_ENVIRONMENT explicitly to test or live for this deployment",
    );
  if (
    configured === "live" &&
    !isProductionDeployment({ ENVIRONMENT: env.ENVIRONMENT, NODE_ENV: env.NODE_ENV })
  )
    fail(
      "LIVE_ENVIRONMENT_FORBIDDEN",
      "Live app billing is available only in a production deployment",
    );
  return configured;
}

/** Checkout, portal and onboarding return URLs are built beneath this configured UI origin. */
export function getAppBillingUiOrigin(
  env: AppBillingRuntimeEnvironment = getCloudAwareEnv(),
): string {
  const configured = env.APP_BILLING_UI_ORIGIN;
  const parsed = z.string().url().safeParse(configured);
  if (!parsed.success)
    fail(
      "UI_ORIGIN_UNCONFIGURED",
      "Set APP_BILLING_UI_ORIGIN to the trusted hosted billing UI origin",
    );
  const url = new URL(parsed.data);
  const local =
    env.ENVIRONMENT === "local" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail(
      "UI_ORIGIN_INVALID",
      "App billing UI origin must be an HTTPS origin without credentials, path, query or fragment",
    );
  return url.origin;
}

/** Dependency injection retains the actual Stripe SDK transport and supports isolated credential-mode tests. */
export function createAppBillingStripeResolver(dependencies: AppBillingStripeDependencies) {
  return async (livemode: boolean): Promise<Stripe> => {
    const env = dependencies.environment();
    const configured = configuredAppBillingEnvironment(env);
    if (livemode && configured !== "live")
      fail("LIVE_ENVIRONMENT_FORBIDDEN", "This deployment does not serve live app billing");
    let stripe: Stripe;
    if (!livemode && configured === "live") {
      const secret = env.STRIPE_TEST_SECRET_KEY?.trim();
      if (!secret || !/^(sk|rk)_test_/.test(secret))
        fail(
          "TEST_CREDENTIAL_UNAVAILABLE",
          "Configure STRIPE_TEST_SECRET_KEY to serve test app registrations in this production deployment",
        );
      stripe = dependencies.testStripe(secret);
    } else stripe = dependencies.deploymentStripe();
    const result = z
      .object({ object: z.literal("balance"), livemode: z.boolean() })
      .safeParse(
        await stripe.balance.retrieve({}, { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION }),
      );
    if (!result.success)
      fail("PROVIDER_MODE_UNAVAILABLE", "Stripe did not return authoritative credential mode");
    if (result.data.livemode !== livemode)
      fail(
        "PROVIDER_MODE_MISMATCH",
        "Stripe credential mode does not match the persisted app billing environment",
      );
    return stripe;
  };
}
const productionResolver = createAppBillingStripeResolver({
  environment: getCloudAwareEnv,
  deploymentStripe: requireStripe,
  testStripe: (secretKey) =>
    new Stripe(secretKey, {
      typescript: true,
      apiVersion: GENERIC_BILLING_STRIPE_API_VERSION as NonNullable<
        ConstructorParameters<typeof Stripe>[1]
      >["apiVersion"],
      maxNetworkRetries: 0,
    }),
});
export const getAppBillingStripe = productionResolver;

/** Provider identity comes from a verified persisted merchant, including the platform account's real ID. */
export function appBillingProviderMerchant(row: {
  id: string;
  provider_account_key: string;
  stripe_account_id: string | null;
  livemode: boolean;
}): BillingProviderMerchant {
  const accountId = row.stripe_account_id;
  if (accountId === null || !/^acct_[A-Za-z0-9]+$/.test(accountId))
    fail(
      "MERCHANT_UNVERIFIED",
      "The app billing merchant requires a verified Stripe account identity",
    );
  if (row.provider_account_key !== "platform" && row.provider_account_key !== accountId)
    fail(
      "MERCHANT_IDENTITY_MISMATCH",
      "The verified Stripe account does not match this merchant binding",
    );
  return {
    merchantId: row.id,
    kind: row.provider_account_key === "platform" ? "platform" : "connected",
    stripeAccountId: accountId,
    livemode: row.livemode,
  };
}
