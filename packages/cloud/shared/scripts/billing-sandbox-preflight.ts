/** Rejects unsafe sandbox destinations before any database mutation or Stripe object creation. */
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { GENERIC_BILLING_STRIPE_API_VERSION } from "../src/lib/services/generic-billing-provider";
export function requireRuntimeSandboxConfiguration(env: NodeJS.ProcessEnv) {
  if (env.GENERIC_BILLING_SANDBOX_RUN !== "1")
    throw new ElizaError("Set GENERIC_BILLING_SANDBOX_RUN=1 for sandbox mutations", {
      code: "BILLING_SANDBOX_OPT_IN_REQUIRED",
    });
  const key = env.GENERIC_BILLING_STRIPE_TEST_KEY;
  if (!key || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key))
    throw new ElizaError("A dedicated Stripe test credential is required", {
      code: "BILLING_SANDBOX_TEST_KEY_REQUIRED",
    });
  const account = env.GENERIC_BILLING_STRIPE_TEST_ACCOUNT;
  if (!account || !/^acct_[A-Za-z0-9]+$/.test(account))
    throw new ElizaError("Select an exact sandbox merchant account", {
      code: "BILLING_SANDBOX_ACCOUNT_REQUIRED",
    });
  const kind = env.GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND;
  if (kind !== "platform" && kind !== "connected")
    throw new ElizaError("Select platform or connected sandbox topology", {
      code: "BILLING_SANDBOX_ACCOUNT_KIND_REQUIRED",
    });
  const config = {
    key,
    account,
    kind: kind as "platform" | "connected",
    receiptPath: env.GENERIC_BILLING_STRIPE_RECEIPT_PATH,
  };

  const raw = env.GENERIC_BILLING_SANDBOX_POSTGRES_URL;
  if (!raw)
    throw new ElizaError("A disposable local PostgreSQL endpoint is required", {
      code: "BILLING_SANDBOX_DATABASE_REQUIRED",
    });
  const database = new URL(raw);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    database.search ||
    database.hash
  )
    throw new ElizaError("Sandbox PostgreSQL must be local and have no connection options", {
      code: "BILLING_SANDBOX_DATABASE_UNSAFE",
    });
  const secret = env.GENERIC_BILLING_SANDBOX_WEBHOOK_SECRET;
  if (!secret || !/^whsec_[A-Za-z0-9]+$/.test(secret))
    throw new ElizaError("A dedicated sandbox forwarding signature secret is required", {
      code: "BILLING_SANDBOX_WEBHOOK_REQUIRED",
    });
  return { ...config, databaseUrl: database.toString(), webhookSecret: secret };
}
export async function verifyRuntimeSandboxAccount(stripe: Stripe, config: { account: string }) {
  const options = { stripeAccount: config.account, apiVersion: GENERIC_BILLING_STRIPE_API_VERSION };
  const account = await stripe.accounts.retrieve(null, {}, options);
  if (account.id !== config.account)
    throw new ElizaError("Credential account differs from selected sandbox", {
      code: "BILLING_SANDBOX_ACCOUNT_MISMATCH",
    });
  const balance = await stripe.balance.retrieve({}, options);
  if (balance.livemode !== false)
    throw new ElizaError("Stripe did not authoritatively confirm test mode", {
      code: "BILLING_SANDBOX_LIVE_MODE",
    });
  return options;
}
