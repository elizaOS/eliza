/**
 * Exercises a real Stripe no-card trial through Cloud's PostgreSQL command journal and finalizer.
 * A local signature boundary feeds the production intake and reconciliation services; an operator
 * forwards actual Acacia sandbox events to this process. This is not Worker/Redis deployment proof.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ElizaError } from "@elizaos/core";
import { serve, sleep } from "bun";
import { Client } from "pg";
import Stripe from "stripe";
import { createGenericBillingProvider } from "../src/lib/services/generic-billing-provider";
import { hasCompletedSandboxEvent } from "./billing-sandbox-completion";
import { initializeBillingSandboxDatabase } from "./billing-sandbox-database";
import {
  requireRuntimeSandboxConfiguration,
  verifyRuntimeSandboxAccount,
} from "./billing-sandbox-preflight";

export async function certifyRuntimeSandbox(env: NodeJS.ProcessEnv) {
  const config = requireRuntimeSandboxConfiguration(env);
  const stripe = new Stripe(config.key, { maxNetworkRetries: 0 });
  const options = await verifyRuntimeSandboxAccount(stripe, config);
  const runId = randomUUID();
  const schema = `billing_sandbox_${runId.replaceAll("-", "_")}`;
  const databaseUrl = new URL(config.databaseUrl);
  databaseUrl.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.TEST_DATABASE_URL = databaseUrl.toString();
  process.env.NODE_ENV = "test";
  process.env.LOCAL_PG_POOL_MAX = "4";
  process.env.APP_BILLING_UI_ORIGIN = "https://cloud.example.test";
  const receiptPath =
    config.receiptPath ?? join(tmpdir(), "eliza-billing-runtime", `${runId}.json`);
  const progress = {
    runId,
    schema,
    accountId: config.account,
    livemode: false,
    status: "initializing",
    pendingOperation: null as string | null,
    objects: {} as Record<string, string>,
    signedEvents: [] as string[],
  };
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, `${JSON.stringify(progress, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  let receiptWrites = Promise.resolve();
  const record = () => {
    const payload = `${JSON.stringify(progress, null, 2)}\n`;
    receiptWrites = receiptWrites.then(() => writeFile(receiptPath, payload, { mode: 0o600 }));
    return receiptWrites;
  };
  const intent = async (operation: string) => {
    progress.pendingOperation = operation;
    await record();
    return { ...options, idempotencyKey: `billing-runtime-sandbox:${runId}:${operation}` };
  };
  const result = async (operation: string, id: string) => {
    progress.objects[operation] = id;
    progress.pendingOperation = null;
    await record();
  };
  const db = new Client({ connectionString: config.databaseUrl });
  let handleRequest: (request: Request) => Promise<Response> = async () =>
    new Response("Initializing", { status: 503 });
  let server: ReturnType<typeof serve> | undefined;
  try {
    // Reserve the receiver before schema or provider mutations; occupied ports fail without orphaned test objects.
    server = serve({
      hostname: "127.0.0.1",
      port: 43127,
      fetch: (request) => handleRequest(request),
    });
    await db.connect();
    await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema},public`);
    // Retain this schema and receipt on failure: provider outcomes must be reconciled before disposal.
    await initializeBillingSandboxDatabase(db);
    const { appSubscriptionAuthorityRepository: authority } = await import(
      "../src/db/repositories/app-subscription-authority"
    );
    const { appBillingProviderBindings } = await import(
      "../src/db/repositories/app-billing-provider-bindings"
    );
    const { appBillingQueries: queries } = await import(
      "../src/db/repositories/app-billing-queries"
    );
    const { GenericBillingRuntime } = await import("../src/lib/services/generic-billing-runtime");
    const { AppBillingReconciliation } = await import(
      "../src/lib/services/app-billing-reconciliation"
    );
    const org = randomUUID(),
      merchant = randomUUID(),
      appId = randomUUID(),
      actorUserId = randomUUID(),
      planId = randomUUID();
    await db.query("INSERT INTO organizations(id) VALUES($1)", [org]);
    await db.query("INSERT INTO users(id) VALUES($1)", [actorUserId]);
    await db.query("INSERT INTO apps(id,organization_id) VALUES($1,$2)", [appId, org]);
    await db.query(
      "INSERT INTO billing_merchants(id,organization_id,provider_account_key,stripe_account_id,livemode,enabled) VALUES($1,$2,$3,$4,false,true)",
      [merchant, org, config.kind === "platform" ? "platform" : config.account, config.account],
    );
    let clockId: string | null = null;
    const product = await stripe.products.create(
      { name: `Cloud billing sandbox ${runId}`, metadata: { eliza_billing_sandbox_run: runId } },
      await intent("product"),
    );
    await result("product", product.id);
    const price = await stripe.prices.create(
      { product: product.id, currency: "usd", unit_amount: 100, recurring: { interval: "month" } },
      await intent("price"),
    );
    await result("price", price.id);
    await db.query(
      `INSERT INTO app_billing_plan_revisions(id,app_id,merchant_id,product_family_key,plan_key,revision,name,amount_cents,currency,interval,maximum_quantity,trial_allowance_usd,paid_allowance_usd,expired_access,entitlements,stripe_price_id,stripe_product_id,published_at) VALUES($1,$2,$3,'main','basic',1,'Basic',100,'usd','month',10,'5.000000','25.000000','read_only','{"features":["inference"],"completionsRpm":60,"embeddingsRpm":60,"standardRpm":60,"strictRpm":10}',$4,$5,now())`,
      [planId, appId, merchant, price.id, product.id],
    );
    const account = await authority.createAccount({
      appId,
      externalAccountKey: runId,
      displayName: "Sandbox workspace",
      principalUserId: actorUserId,
    });
    const identity = {
      appId,
      actorUserId,
      billingAccountId: account.id,
      productFamilyKey: "main",
      livemode: false,
      clientRegistrationId: null,
    };
    const scope = await authority.resolveScope({ ...identity, merchantId: merchant });
    await result("scope", scope.scopeId);
    // Only fixture addition: attach the clock while the real provider creates its customer.
    // Runtime still owns command intent, request metadata, provider dispatch and durable binding.
    const createCustomer = stripe.customers.create.bind(stripe.customers);
    stripe.customers.create = async (params, requestOptions) => {
      const claimed = await db.query<{ starts_at: Date }>(
        "SELECT starts_at FROM app_subscription_trials WHERE command_id=$1",
        [params?.metadata && params.metadata.eliza_command_id],
      );
      if (claimed.rows.length !== 1)
        throw new ElizaError("Test Clock requires the durable trial claim", {
          code: "BILLING_SANDBOX_TRIAL_CLAIM_MISSING",
        });
      const clock = await stripe.testHelpers.testClocks.create(
        {
          frozen_time: Math.floor(claimed.rows[0]!.starts_at.getTime() / 1000),
          name: `Cloud billing ${runId}`,
        },
        await intent("clock"),
      );
      clockId = clock.id;
      await result("clock", clock.id);
      return createCustomer({ ...params, test_clock: clock.id }, requestOptions);
    };
    const provider = async (merchantId: string, livemode: boolean) => {
      if (merchantId !== merchant || livemode)
        throw new ElizaError("Unexpected sandbox merchant", {
          code: "BILLING_SANDBOX_SCOPE_MISMATCH",
        });
      return createGenericBillingProvider(
        stripe,
        { merchantId, stripeAccountId: config.account, kind: config.kind, livemode: false },
        appBillingProviderBindings,
      );
    };
    const runtime = new GenericBillingRuntime(provider);
    const reconciler = new AppBillingReconciliation({
      provider,
      reconcileCommand: (input) => runtime.reconcileCommand(input),
    });
    const { createRuntimeSandboxIngress } = await import("./billing-sandbox-ingress");
    handleRequest = createRuntimeSandboxIngress({
      stripe,
      account: config.account,
      webhookSecret: config.webhookSecret,
      reconciler,
      onProcessed: async (eventId) => {
        if (!progress.signedEvents.includes(eventId)) progress.signedEvents.push(eventId);
        await record();
      },
    });
    process.stdout.write(
      `${JSON.stringify({ status: "sandbox_ingress_ready", receiptPath, schema, endpoint: "http://127.0.0.1:43127/stripe/webhook" })}\n`,
    );
    const operation = await runtime.prepare(identity, {
      idempotencyKey: `trial:${runId}`,
      expectedSubscriptionRevision: null,
      payload: {
        version: 1,
        domain: "buyer",
        action: "trial",
        planRevisionId: planId,
        quantity: 3,
      },
    });
    if (operation.status !== "succeeded")
      throw new ElizaError("Trial command did not finalize", {
        code: "BILLING_SANDBOX_TRIAL_PENDING",
      });
    const trial = await queries.snapshot(identity);
    if (trial.kind !== "subscription" || trial.subscription.status !== "trialing")
      throw new ElizaError("Trial snapshot is not authoritative", {
        code: "BILLING_SANDBOX_TRIAL_STATE",
      });
    const subscriptionId = trial.subscription.stripe_subscription_id;
    await result("subscription", subscriptionId);
    const observed = await stripe.subscriptions.retrieve(subscriptionId, {}, options);
    if (
      observed.livemode ||
      observed.trial_end === null ||
      observed.trial_start === null ||
      observed.trial_end - observed.trial_start !== 7 * 86400 ||
      observed.items.data[0]?.quantity !== 3
    )
      throw new ElizaError("Provider trial differs from Cloud contract", {
        code: "BILLING_SANDBOX_TRIAL_CONTRACT",
      });
    if (!clockId)
      throw new ElizaError("Trial customer has no Test Clock", {
        code: "BILLING_SANDBOX_CLOCK_MISSING",
      });
    await stripe.testHelpers.testClocks.advance(
      clockId,
      { frozen_time: observed.trial_end + 1 },
      await intent("advance"),
    );
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await reconciler.recoverIntake();
      const current = await queries.snapshot(identity);
      if (
        current.kind === "subscription" &&
        current.subscription.status === "paused" &&
        (await hasCompletedSandboxEvent(db, subscriptionId, "customer.subscription.paused"))
      ) {
        const providerState = await stripe.subscriptions.retrieve(subscriptionId, {}, options);
        if (providerState.status !== "paused" || providerState.trial_end !== observed.trial_end)
          throw new ElizaError("Provider and database differ after expiry", {
            code: "BILLING_SANDBOX_EXPIRY_MISMATCH",
          });
        progress.pendingOperation = null;
        progress.status = "runtime_signed_trial_expiry_passed";
        await record();
        return progress;
      }
      await sleep(1000);
    }
    throw new ElizaError(
      "Signed sandbox expiry did not complete before deadline; retain schema and reconcile receipts",
      { code: "BILLING_SANDBOX_SIGNED_EXPIRY_PENDING" },
    );
  } finally {
    if (server) await server.stop(true);
    await (await import("../src/db/client")).closeDatabaseConnectionsForTests();
    await db.end();
  }
}
if (import.meta.main) {
  certifyRuntimeSandbox(process.env)
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error: unknown) => {
      // error-policy:J1 CLI exposes only a stable failure code; never provider messages or credentials.
      process.stderr.write(
        `${JSON.stringify({ status: "failed", code: error instanceof ElizaError ? error.code : "BILLING_SANDBOX_RUNTIME_FAILURE" })}\n`,
      );
      process.exitCode = 1;
    });
}
