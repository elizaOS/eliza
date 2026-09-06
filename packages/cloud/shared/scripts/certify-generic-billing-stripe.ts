/**
 * Runs opt-in Stripe sandbox subscription smoke and Test Clock expiry through the provider adapter.
 * This creates test objects only and emits a receipt; it does not certify Worker webhook delivery,
 * database finalization, browser Checkout completion or production configuration.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ElizaError } from "@elizaos/core";
import Stripe from "stripe";
import { z } from "zod";
import {
  type BillingProviderObjectBinding,
  type BillingProviderPlan,
  createGenericBillingProvider,
  type DurableProviderIntent,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "../src/lib/services/generic-billing-provider";

interface SandboxEnvironment {
  GENERIC_BILLING_SANDBOX_RUN?: string;
  GENERIC_BILLING_STRIPE_TEST_KEY?: string;
  GENERIC_BILLING_STRIPE_TEST_ACCOUNT?: string;
  GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND?: string;
  GENERIC_BILLING_STRIPE_RECEIPT_PATH?: string;
}
/** Resolves dedicated test credentials without falling back to Cloud's production Stripe key. */
export function requireBillingSandboxConfiguration(env: SandboxEnvironment): {
  key: string;
  account: string;
  kind: "platform" | "connected";
  receiptPath: string | undefined;
} {
  if (env.GENERIC_BILLING_SANDBOX_RUN !== "1")
    throw new ElizaError(
      "Set GENERIC_BILLING_SANDBOX_RUN=1 to create disposable test billing objects",
      { code: "BILLING_SANDBOX_OPT_IN_REQUIRED" },
    );
  const key = env.GENERIC_BILLING_STRIPE_TEST_KEY;
  if (!key || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key))
    throw new ElizaError("A dedicated Stripe test credential is required", {
      code: "BILLING_SANDBOX_TEST_KEY_REQUIRED",
    });
  const account = env.GENERIC_BILLING_STRIPE_TEST_ACCOUNT;
  if (!account || !/^acct_[A-Za-z0-9]+$/.test(account))
    throw new ElizaError("An explicitly selected test merchant account is required", {
      code: "BILLING_SANDBOX_ACCOUNT_REQUIRED",
    });
  const kind = env.GENERIC_BILLING_STRIPE_TEST_ACCOUNT_KIND;
  if (kind !== "platform" && kind !== "connected")
    throw new ElizaError("Select platform or connected for the sandbox merchant", {
      code: "BILLING_SANDBOX_ACCOUNT_KIND_REQUIRED",
    });
  return { key, account, kind, receiptPath: env.GENERIC_BILLING_STRIPE_RECEIPT_PATH };
}

export async function certifyBillingSandbox(env: SandboxEnvironment) {
  const config = requireBillingSandboxConfiguration(env);
  const stripe = new Stripe(config.key, { maxNetworkRetries: 0 });
  const options: Stripe.RequestOptions = {
    stripeAccount: config.account,
    apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
  };
  const balance = z
    .object({ livemode: z.literal(false) })
    .parse(await stripe.balance.retrieve({}, options));
  const runId = randomUUID();
  const scope = { scopeId: randomUUID(), appId: randomUUID(), billingAccountId: randomUUID() };
  const merchant = {
    merchantId: randomUUID(),
    stripeAccountId: config.account,
    kind: config.kind,
    livemode: balance.livemode,
  };
  const bindings = new Map<string, BillingProviderObjectBinding>();
  const provider = createGenericBillingProvider(stripe, merchant, {
    resolveBinding: async (input) => bindings.get(input.objectId) ?? null,
  });
  const makeIntent = (operation: string): DurableProviderIntent => ({
    commandId: `${runId}:${operation}`,
    idempotencyKey: `billing-sandbox:${runId}:${operation}`,
    requestDigest: createHash("sha256")
      .update(JSON.stringify({ runId, operation, scope, merchant }))
      .digest("hex"),
  });
  const receiptPath = config.receiptPath ?? join(tmpdir(), "eliza-billing-stripe", `${runId}.json`);
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const progress: {
    runId: string;
    accountId: string;
    livemode: false;
    receiptPath: string;
    pendingOperation: string | null;
    intents: Record<string, DurableProviderIntent>;
    objects: Record<string, string>;
  } = {
    runId,
    accountId: config.account,
    livemode: false,
    receiptPath,
    pendingOperation: null,
    intents: {},
    objects: {},
  };
  await writeFile(receiptPath, `${JSON.stringify(progress, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const record = async (operation: string, objectId?: string) => {
    progress.pendingOperation = objectId ? null : operation;
    if (objectId) progress.objects[operation] = objectId;
    else progress.intents[operation] = makeIntent(operation);
    await writeFile(receiptPath, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
  };
  process.stdout.write(
    `${JSON.stringify({ status: "sandbox_intent_journal_created", receiptPath })}\n`,
  );
  const frozenTime = Math.floor(Date.now() / 1000);
  await record("clock");
  const clock = await stripe.testHelpers.testClocks.create(
    { frozen_time: frozenTime, name: `Generic billing ${runId}` },
    { ...options, idempotencyKey: makeIntent("clock").idempotencyKey },
  );
  await record("clock", clock.id);
  await record("product");
  const product = await stripe.products.create(
    { name: `Generic billing sandbox ${runId}`, metadata: { eliza_billing_sandbox_run: runId } },
    { ...options, idempotencyKey: makeIntent("product").idempotencyKey },
  );
  await record("product", product.id);
  await record("price");
  const price = await stripe.prices.create(
    {
      product: product.id,
      currency: "usd",
      unit_amount: 100,
      recurring: { interval: "month" },
      metadata: { eliza_billing_sandbox_run: runId },
    },
    { ...options, idempotencyKey: makeIntent("price").idempotencyKey },
  );
  await record("price", price.id);
  const plan: BillingProviderPlan = {
    planRevisionId: randomUUID(),
    priceId: price.id,
    productId: product.id,
    amountCents: 100,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    minimumQuantity: 1,
    maximumQuantity: 10,
    trialDays: 7,
  };
  // The test-clock association is fixture setup; production customer ownership is still verified by the adapter.
  await record("customer");
  const customer = await stripe.customers.create(
    {
      test_clock: clock.id,
      metadata: {
        eliza_billing_scope_id: scope.scopeId,
        eliza_app_id: scope.appId,
        eliza_billing_account_id: scope.billingAccountId,
        eliza_merchant_id: merchant.merchantId,
        eliza_billing_sandbox_run: runId,
      },
    },
    { ...options, idempotencyKey: makeIntent("customer").idempotencyKey },
  );
  await record("customer", customer.id);
  bindings.set(customer.id, {
    appId: scope.appId,
    billingAccountId: scope.billingAccountId,
    scopeId: null,
  });
  await record("trial");
  const trial = await provider.startTrial(
    scope,
    {
      customerId: customer.id,
      plan,
      quantity: 1,
      trialClaim: { startsAt: frozenTime, endsAt: frozenTime + 7 * 86400 },
    },
    makeIntent("trial"),
  );
  await record("trial", trial.value.subscriptionId);
  bindings.set(trial.value.subscriptionId, scope);
  if (trial.value.trialEnd === null)
    throw new ElizaError("Stripe returned no trial expiry", {
      code: "BILLING_SANDBOX_TRIAL_MISSING",
    });
  await record("advance");
  await stripe.testHelpers.testClocks.advance(
    clock.id,
    { frozen_time: trial.value.trialEnd + 1 },
    { ...options, idempotencyKey: makeIntent("advance").idempotencyKey },
  );
  let clockReady = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const observed = await stripe.testHelpers.testClocks.retrieve(clock.id, {}, options);
    if (observed.status === "ready") {
      clockReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!clockReady)
    throw new ElizaError(
      "Stripe Test Clock did not complete; reconcile the recorded test clock before retrying",
      { code: "BILLING_SANDBOX_CLOCK_PENDING" },
    );
  await record("advance", clock.id);
  const expired = await provider.retrieveSubscription(scope, {
    subscriptionId: trial.value.subscriptionId,
    customerId: customer.id,
    plan,
  });
  if (expired.value.status !== "paused" || expired.value.trialEnd !== trial.value.trialEnd)
    throw new ElizaError("No-card trial did not pause without extending its interval", {
      code: "BILLING_SANDBOX_TRIAL_EXPIRY",
    });
  const receipt = {
    ...progress,
    status: "provider_trial_smoke_passed",
    runId,
    apiVersion: GENERIC_BILLING_STRIPE_API_VERSION,
    accountId: config.account,
    livemode: false,
    clockId: clock.id,
    customerId: customer.id,
    productId: product.id,
    priceId: price.id,
    trial,
    expired,
    limitations: [
      "No live-mode resources or charges",
      "Customer Test Clock association used direct SDK fixture setup",
      "No Worker webhook signature delivery, database finalizer, browser payment setup, paid conversion, refund or Connect onboarding certification",
      "Test objects retained for manual inspection; reruns create a distinct run",
    ],
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

if (import.meta.main) {
  certifyBillingSandbox(process.env)
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`))
    .catch((error: unknown) => {
      // error-policy:J1 CLI failures expose a stable code without provider credentials or raw payment data.
      process.stderr.write(
        `${JSON.stringify({ status: "failed", code: error instanceof ElizaError ? error.code : "BILLING_SANDBOX_PROVIDER_FAILURE" })}\n`,
      );
      process.exitCode = 1;
    });
}
