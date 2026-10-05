/**
 * Exercises org Plus/Pro checkout replay, supersession, stale-command recovery, fencing and the
 * Customer Portal through migrated PGlite transactions and the real Stripe SDK against a
 * controlled loopback HTTP provider; no live provider evidence is claimed.
 */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.NODE_ENV = "test";
process.env.CLOUD_E2E = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
process.env.NEXT_PUBLIC_APP_URL = "https://cloud.example.test";
process.env.NEXT_PUBLIC_API_URL = "https://api.example.test";
process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_cloudcheckout";
setDefaultTimeout(180_000);

const HOUR = 60 * 60 * 1000;
const ACCOUNT_ID = "acct_checkouttest";

type Row = Record<string, unknown>;
interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
  idempotencyKey: string | undefined;
}
const requests: RecordedRequest[] = [];
const sessions = new Map<string, Row>();
const sessionsByKey = new Map<string, string>();
let configurations: Row[] = [];
const configurationsByKey = new Map<string, string>();
let portalUrl = "https://billing.stripe.com/p/session/test_portal";
let sequence = 0;

function priceObject(id: string) {
  const plus = id === "price_plus";
  return {
    id,
    object: "price",
    active: true,
    currency: "usd",
    currency_options: { usd: { unit_amount: plus ? 3000 : 10000 } },
    unit_amount: plus ? 3000 : 10000,
    type: "recurring",
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: {
      interval: "month",
      interval_count: 1,
      trial_period_days: null,
      usage_type: "licensed",
    },
    product: plus ? "prod_plus" : "prod_pro",
    livemode: false,
  };
}

function configurationFrom(id: string, body: URLSearchParams, previous?: Row): Row {
  const flag = (name: string, fallback: boolean) =>
    body.has(name) ? body.get(name) === "true" : fallback;
  const features = (previous?.features ?? {}) as Record<string, Record<string, unknown>>;
  return {
    id,
    object: "billing_portal.configuration",
    active: true,
    livemode: false,
    metadata: {
      ...((previous?.metadata as Row | undefined) ?? {}),
      ...Object.fromEntries(
        [...body.entries()]
          .filter(([key]) => key.startsWith("metadata["))
          .map(([key, value]) => [key.slice("metadata[".length, -1), value]),
      ),
    },
    features: {
      customer_update: {
        enabled: flag("features[customer_update][enabled]", !!features.customer_update?.enabled),
      },
      invoice_history: {
        enabled: flag("features[invoice_history][enabled]", !!features.invoice_history?.enabled),
      },
      payment_method_update: {
        enabled: flag(
          "features[payment_method_update][enabled]",
          !!features.payment_method_update?.enabled,
        ),
      },
      subscription_cancel: {
        enabled: flag(
          "features[subscription_cancel][enabled]",
          !!features.subscription_cancel?.enabled,
        ),
        mode:
          body.get("features[subscription_cancel][mode]") ??
          features.subscription_cancel?.mode ??
          "at_period_end",
      },
      subscription_update: {
        enabled: flag(
          "features[subscription_update][enabled]",
          !!features.subscription_update?.enabled,
        ),
      },
    },
  };
}

function list(data: Row[], url: string) {
  return { object: "list", data, has_more: false, url };
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const header = request.headers["idempotency-key"];
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body,
      idempotencyKey: typeof header === "string" ? header : undefined,
    };
    requests.push(recorded);
    response.setHeader("Content-Type", "application/json");
    const send = (status: number, value: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    const fail = (status: number, message: string) =>
      send(status, { error: { type: "invalid_request_error", message } });
    const { method } = recorded;
    const path = url.pathname;
    if (method === "GET" && path === "/v1/account")
      return send(200, { id: ACCOUNT_ID, object: "account" });
    if (method === "GET" && path.startsWith("/v1/prices/"))
      return send(200, priceObject(path.split("/").at(-1) ?? ""));
    if (method === "GET" && path.startsWith("/v1/products/"))
      return send(200, {
        id: path.split("/").at(-1),
        object: "product",
        active: true,
        livemode: false,
      });
    if (method === "GET" && path === "/v1/checkout/sessions")
      return send(
        200,
        list(
          [...sessions.values()].filter(
            (session) => session.customer === url.searchParams.get("customer"),
          ),
          path,
        ),
      );
    if (method === "POST" && path === "/v1/checkout/sessions") {
      const replay = recorded.idempotencyKey && sessionsByKey.get(recorded.idempotencyKey);
      if (replay) return send(200, sessions.get(replay));
      const id = `cs_test_${++sequence}`;
      const embedded = body.get("ui_mode") === "embedded";
      const session = {
        id,
        object: "checkout.session",
        ui_mode: embedded ? "embedded" : "hosted",
        client_secret: embedded ? `${id}_secret_loopback` : null,
        amount_total: priceObject(body.get("line_items[0][price]") ?? "").unit_amount,
        mode: "subscription",
        status: "open",
        payment_status: "unpaid",
        customer: body.get("customer"),
        subscription: null,
        invoice: null,
        client_reference_id: body.get("client_reference_id"),
        livemode: false,
        currency: body.get("currency"),
        expires_at: Number(body.get("expires_at")),
        metadata: {
          app: body.get("metadata[app]"),
          organization_id: body.get("metadata[organization_id]"),
          command_id: body.get("metadata[command_id]"),
        },
        url: embedded ? null : `https://checkout.stripe.com/c/pay/${id}`,
      };
      sessions.set(id, session);
      if (recorded.idempotencyKey) sessionsByKey.set(recorded.idempotencyKey, id);
      return send(200, session);
    }
    const sessionMatch = path.match(
      /^\/v1\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)(\/expire)?$/,
    );
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1] ?? "");
      if (!session) return fail(404, "No such checkout session");
      if (method === "POST" && sessionMatch[2]) {
        if (session.status !== "open") return fail(400, "Only open sessions can be expired");
        session.status = "expired";
        session.url = null;
        return send(200, session);
      }
      if (method === "GET") return send(200, session);
    }
    if (method === "GET" && path === "/v1/billing_portal/configurations")
      return send(
        200,
        list(
          configurations.filter((configuration) => configuration.active === true),
          path,
        ),
      );
    if (method === "POST" && path === "/v1/billing_portal/configurations") {
      const replay = recorded.idempotencyKey && configurationsByKey.get(recorded.idempotencyKey);
      if (replay)
        return send(
          200,
          configurations.find((row) => row.id === replay),
        );
      const created = configurationFrom(`bpc_${++sequence}`, body);
      configurations.push(created);
      if (recorded.idempotencyKey)
        configurationsByKey.set(recorded.idempotencyKey, created.id as string);
      return send(200, created);
    }
    const configurationMatch = path.match(/^\/v1\/billing_portal\/configurations\/(bpc_\d+)$/);
    if (method === "POST" && configurationMatch) {
      const index = configurations.findIndex((row) => row.id === configurationMatch[1]);
      if (index < 0) return fail(404, "No such configuration");
      const updated = configurationFrom(configurationMatch[1] ?? "", body, configurations[index]);
      configurations[index] = updated;
      return send(200, updated);
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions")
      return send(200, {
        id: `bps_${++sequence}`,
        object: "billing_portal.session",
        customer: body.get("customer"),
        configuration: body.get("configuration"),
        return_url: body.get("return_url"),
        livemode: false,
        url: portalUrl,
      });
    return fail(404, `Unexpected controlled provider request ${method} ${path}`);
  });
});

let client: typeof import("../../db/client");
let operations: typeof import("../../db/repositories/subscription-billing-operations").subscriptionBillingOperationsRepository;
let checkout: typeof import("./subscription-checkout");
let portal: typeof import("./subscription-customer-portal");
let contracts: typeof import("./subscription-checkout-contract");

async function query<T extends Row = Row>(sql: string, values: unknown[] = []) {
  return (await client.getPgliteClientForTests().query<T>(sql, values)).rows;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback address missing");
  process.env.STRIPE_CLOUD_E2E_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  client = await import("../../db/client");
  const execute = (sql: string) => client.getPgliteClientForTests().exec(sql);
  await installCancellationTestSchema(execute);
  await execute(
    "ALTER TABLE organizations ADD COLUMN IF NOT EXISTS name text; ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_email text;",
  );
  const customerAttempts = await readFile(
    new URL("../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    "utf8",
  );
  // Only the attempt table: bound customer authority is the precondition, not the subject.
  await execute(customerAttempts.split("--> statement-breakpoint")[0] ?? "");
  operations = (await import("../../db/repositories/subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  checkout = await import("./subscription-checkout");
  portal = await import("./subscription-customer-portal");
  contracts = await import("./subscription-checkout-contract");
});
beforeEach(() => {
  requests.length = 0;
  portalUrl = "https://billing.stripe.com/p/session/test_portal";
});
afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  await client.closeDatabaseConnectionsForTests();
});

async function seedOrganization() {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const customerId = `cus_${organizationId.replaceAll("-", "")}`;
  await query("INSERT INTO organizations(id,stripe_customer_id,name) VALUES($1,$2,'Org')", [
    organizationId,
    customerId,
  ]);
  await query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    actorId,
    organizationId,
  ]);
  await query(
    `INSERT INTO stripe_customer_attempts(organization_id,generation,request_digest,caller_intent,idempotency_key,status,provider_customer_id,provider_receipt,provider_started_at,bound_at,provider_livemode)
     VALUES($1,1,$2,'interactive_checkout',$3,'bound',$4,$5,now(),now(),false)`,
    [
      organizationId,
      "c".repeat(64),
      `attempt-${organizationId}`,
      customerId,
      JSON.stringify({ customer_id: customerId }),
    ],
  );
  return { organizationId, actorId, customerId };
}

type Org = Awaited<ReturnType<typeof seedOrganization>>;

async function seedCheckout(
  org: Org,
  planKey: "plus_monthly" | "pro_monthly",
  options: { createdAt?: Date; dispatched?: boolean; idempotencyKey?: string } = {},
) {
  const id = randomUUID();
  const createdAt = options.createdAt ?? new Date();
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const plus = planKey === "plus_monthly";
  const contract = contracts.requireCheckoutContract({
    version: 1,
    catalogVersion: "v1",
    planKey,
    accountId: ACCOUNT_ID,
    expectedLivemode: false,
    priceId: plus ? "price_plus" : "price_pro",
    productId: plus ? "prod_plus" : "prod_pro",
    params: {
      mode: "subscription",
      currency: "usd",
      customer: org.customerId,
      client_reference_id: id,
      line_items: [{ price: plus ? "price_plus" : "price_pro", quantity: 1 }],
      payment_method_types: ["card"],
      allow_promotion_codes: false,
      automatic_tax: { enabled: false },
      metadata: { app: "eliza-cloud", organization_id: org.organizationId, command_id: id },
      subscription_data: {
        metadata: { app: "eliza-cloud", organization_id: org.organizationId, command_id: id },
      },
      success_url:
        "https://cloud.example.test/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}",
      cancel_url: `https://cloud.example.test${contracts.SUBSCRIPTION_CHECKOUT_CANCEL_PATH}`,
      expires_at: Math.floor((createdAt.getTime() + checkout.CHECKOUT_SESSION_TTL_MS) / 1000),
    },
  });
  let command = (
    await operations.enqueueCommand({
      id,
      organizationId: org.organizationId,
      requestedByUserId: org.actorId,
      kind: "checkout",
      subscriptionId: null,
      targetPlanKey: planKey,
      expectedSubscriptionRevision: null,
      idempotencyKey,
      providerIdempotencyKey: `eliza-subscription-${createHash("sha256").update(`${org.organizationId}:${idempotencyKey}`).digest("hex")}`,
      requestDigest: createHash("sha256").update(id).digest("hex"),
      checkoutContract: contract,
      now: createdAt,
    })
  ).value;
  if (options.dispatched) {
    const claimed = await operations.markCommandOutcomeUnknown({
      organizationId: org.organizationId,
      commandId: id,
      expectedStateRevision: command.state_revision,
      expectedExecutionGeneration: command.execution_generation,
    });
    if (!claimed) throw new Error("fixture dispatch failed");
    command = claimed;
  }
  return { command, idempotencyKey, contract };
}

function openSession(org: Org, commandId: string, status: "open" | "complete" | "expired") {
  const id = `cs_test_${++sequence}`;
  sessions.set(id, {
    id,
    object: "checkout.session",
    mode: "subscription",
    status,
    payment_status: status === "complete" ? "paid" : "unpaid",
    customer: org.customerId,
    subscription: status === "complete" ? `sub_${sequence}` : null,
    invoice: status === "complete" ? `in_${sequence}` : null,
    client_reference_id: commandId,
    livemode: false,
    metadata: { app: "eliza-cloud", organization_id: org.organizationId, command_id: commandId },
    url: status === "open" ? `https://checkout.stripe.com/c/pay/${id}` : null,
  });
  return id;
}

function submit(
  org: Org,
  planKey: "plus_monthly" | "pro_monthly",
  idempotencyKey: string,
  presentation?: "hosted" | "embedded" | "shared",
) {
  let reauthorizations = 0;
  const result = checkout.submitSubscriptionCheckout(
    {
      organizationId: org.organizationId,
      actorId: org.actorId,
      planKey,
      idempotencyKey,
      ...(presentation ? { presentation } : {}),
    },
    async () => {
      reauthorizations++;
    },
  );
  return { result, reauthorizations: () => reauthorizations };
}

async function commandRow(id: string) {
  const [row] = await query<{ status: string; error_code: string | null }>(
    "SELECT status,error_code FROM billing_subscription_commands WHERE id=$1",
    [id],
  );
  return row;
}

const providerWrites = () => requests.filter((request) => request.method !== "GET");

test("an applied replay is completed only while its subscription is still live", async () => {
  const org = await seedOrganization();
  const { command, idempotencyKey } = await seedCheckout(org, "plus_monthly", {
    dispatched: true,
  });
  const { subscriptionAuthorityRepository } = await import(
    "../../db/repositories/subscription-authority"
  );
  const now = Date.now();
  await subscriptionAuthorityRepository.create(
    {
      id: command.id,
      organization_id: org.organizationId,
      provider: "stripe",
      provider_environment: "test",
      stripe_customer_id: org.customerId,
      stripe_subscription_id: `sub_${command.id.replaceAll("-", "")}`,
      stripe_subscription_item_id: `si_${command.id.replaceAll("-", "")}`,
      plan_key: "plus_monthly",
      catalog_version: "v1",
      status: "active",
      current_period_start: new Date(now - 86_400_000),
      current_period_end: new Date(now + 86_400_000),
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      dunning_started_at: null,
      grace_expires_at: null,
      pending_plan_key: null,
      last_provider_event_id: null,
      last_provider_event_created_at: null,
      provider_object_digest: "a".repeat(64),
    },
    "checkout",
    null,
  );
  await query(
    "UPDATE billing_subscription_commands SET status='APPLIED',state_revision=state_revision+1,provider_response_digest=$2,completed_at=now(),result_subscription_id=id,applied_at=now() WHERE id=$1",
    [command.id, "d".repeat(64)],
  );
  expect(await submit(org, "plus_monthly", idempotencyKey).result).toEqual({
    status: "completed",
    commandId: command.id,
    checkoutUrl: null,
  });
  await query(
    "UPDATE billing_subscriptions SET status='canceled',canceled_at=now(),ended_at=now() WHERE id=$1",
    [command.id],
  );
  expect(await submit(org, "plus_monthly", idempotencyKey).result).toEqual({
    status: "stale_intent",
    commandId: command.id,
    checkoutUrl: null,
  });
  expect(providerWrites()).toEqual([]);
});

test("a failed checkout replay is expired instead of a permanent retry state", async () => {
  const org = await seedOrganization();
  const { command, idempotencyKey } = await seedCheckout(org, "plus_monthly", {
    dispatched: true,
  });
  await operations.resolveCommandOutcome({
    organizationId: org.organizationId,
    commandId: command.id,
    expectedStateRevision: command.state_revision,
    expectedExecutionGeneration: command.execution_generation,
    outcome: "FAILED",
    providerResponseDigest: null,
    errorCode: "CHECKOUT_EXPIRED",
  });
  expect(await submit(org, "plus_monthly", idempotencyKey).result).toEqual({
    status: "expired",
    commandId: command.id,
    checkoutUrl: null,
  });
  expect(requests).toEqual([]);
});

test("a stuck prepared checkout near expiry is superseded and never blocks a fresh purchase", async () => {
  const org = await seedOrganization();
  const { command, idempotencyKey } = await seedCheckout(org, "plus_monthly", {
    createdAt: new Date(Date.now() - (23 * HOUR + 40 * 60 * 1000)),
  });
  expect(await submit(org, "plus_monthly", idempotencyKey).result).toMatchObject({
    status: "expired",
    commandId: command.id,
  });
  expect(await commandRow(command.id)).toEqual({
    status: "SUPERSEDED",
    error_code: "CHECKOUT_CONTRACT_EXPIRED",
  });
  expect(providerWrites()).toEqual([]);

  const before = Date.now();
  const fresh = await submit(org, "plus_monthly", randomUUID()).result;
  expect(fresh.status).toBe("open");
  const create = providerWrites().find((request) => request.path === "/v1/checkout/sessions");
  expect(create?.body.get("currency")).toBe("usd");
  expect(create?.body.get("cancel_url")).toBe(
    "https://cloud.example.test/cloud/billing?subscription_checkout=canceled",
  );
  const expiresAt = Number(create?.body.get("expires_at")) * 1000;
  // 23h55m: under Stripe's 24h ceiling even with provider clock skew.
  expect(expiresAt).toBeGreaterThan(before + 23 * HOUR + 54 * 60 * 1000);
  expect(expiresAt).toBeLessThan(Date.now() + 24 * HOUR - 4 * 60 * 1000);
  expect(
    requests.some(
      (request) =>
        request.path === "/v1/prices/price_plus" &&
        [...request.query.values()].includes("currency_options"),
    ),
  ).toBe(true);
});

test("a dispatched checkout with no session after its provider deadline fails as expired", async () => {
  const org = await seedOrganization();
  const { command, idempotencyKey } = await seedCheckout(org, "plus_monthly", {
    createdAt: new Date(Date.now() - 24 * HOUR),
    dispatched: true,
  });
  expect(await submit(org, "plus_monthly", idempotencyKey).result).toMatchObject({
    status: "expired",
  });
  expect(await commandRow(command.id)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_EXPIRED",
  });
  expect(providerWrites()).toEqual([]);
});

test("a different-plan request expires the open checkout and continues with the new plan", async () => {
  const org = await seedOrganization();
  const pending = await seedCheckout(org, "plus_monthly", { dispatched: true });
  const sessionId = openSession(org, pending.command.id, "open");
  const result = await submit(org, "pro_monthly", randomUUID()).result;
  expect(result.status).toBe("open");
  expect(sessions.get(sessionId)?.status).toBe("expired");
  expect(providerWrites().map((request) => request.path)).toEqual([
    `/v1/checkout/sessions/${sessionId}/expire`,
    "/v1/checkout/sessions",
  ]);
  expect(await commandRow(pending.command.id)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_SUPERSEDED_BY_PLAN_CHANGE",
  });
  const current = await operations.findPendingCheckout(org.organizationId);
  expect(current?.id).toBe(result.commandId);
  expect(current?.target_plan_key).toBe("pro_monthly");
});

test("a different-plan request never starts a second purchase after the pending one completed", async () => {
  const org = await seedOrganization();
  const pending = await seedCheckout(org, "plus_monthly", { dispatched: true });
  openSession(org, pending.command.id, "complete");
  await expect(submit(org, "pro_monthly", randomUUID()).result).rejects.toBeDefined();
  expect(providerWrites().some((request) => request.path === "/v1/checkout/sessions")).toBe(false);
  const commands = await query(
    "SELECT id,status FROM billing_subscription_commands WHERE organization_id=$1",
    [org.organizationId],
  );
  expect(commands).toEqual([{ id: pending.command.id, status: "OUTCOME_UNKNOWN" }]);
});

const sessionCreates = () =>
  providerWrites().filter((request) => request.path === "/v1/checkout/sessions");

test("embedded checkout returns an in-app client secret, server quote and no redirect", async () => {
  const org = await seedOrganization();
  const key = randomUUID();
  const result = await submit(org, "plus_monthly", key, "embedded").result;
  if (result.status !== "open" || !("presentation" in result) || result.presentation !== "embedded")
    throw new Error("expected an open embedded checkout");
  expect(result).toMatchObject({
    checkoutUrl: null,
    uiMode: "embedded",
    publishableKey: "pk_test_cloudcheckout",
    amountDueCents: 3000,
    currency: "usd",
    interval: "month",
  });
  expect(result.clientSecret).toBe(`${result.sessionId}_secret_loopback`);
  expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 23 * HOUR);
  const [create] = sessionCreates();
  expect(create?.body.get("ui_mode")).toBe("embedded");
  expect(create?.body.get("redirect_on_completion")).toBe("never");
  expect(create?.body.get("payment_method_types[0]")).toBe("card");
  expect(create?.body.has("payment_method_types[1]")).toBe(false);
  expect(create?.body.has("success_url")).toBe(false);
  expect(create?.body.has("cancel_url")).toBe(false);
  expect(create?.body.has("return_url")).toBe(false);

  // The same intent resumes the same provider session.
  requests.length = 0;
  expect(await submit(org, "plus_monthly", key, "embedded").result).toEqual(result);
  expect(sessionCreates()).toEqual([]);
  // Another device asking for the same plan in the same presentation resumes it too.
  expect(await submit(org, "plus_monthly", randomUUID(), "embedded").result).toEqual(result);
  expect(sessionCreates()).toEqual([]);
});

test("embedded checkout fails before any provider write without a same-mode publishable key", async () => {
  const org = await seedOrganization();
  for (const value of [
    undefined,
    "pk_live_wrongmode",
    ["sk", "test", "notpublishable"].join("_"),
  ]) {
    if (value === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = value;
    requests.length = 0;
    try {
      await expect(
        submit(org, "plus_monthly", randomUUID(), "embedded").result,
      ).rejects.toMatchObject({
        code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
        context: { reason: "publishable_key_unavailable" },
      });
      expect(providerWrites()).toEqual([]);
    } finally {
      process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_cloudcheckout";
    }
  }
  const commands = await query(
    "SELECT id FROM billing_subscription_commands WHERE organization_id=$1",
    [org.organizationId],
  );
  expect(commands).toEqual([]);
});

test("shared checkout is a hosted link that returns to the public payer page without session ids", async () => {
  const org = await seedOrganization();
  const result = await submit(org, "pro_monthly", randomUUID(), "shared").result;
  expect(result).toMatchObject({ status: "open", presentation: "shared" });
  if (!("expiresAt" in result) || typeof result.checkoutUrl !== "string")
    throw new Error("expected a shared link");
  expect(new URL(result.checkoutUrl).hostname).toBe("checkout.stripe.com");
  expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 23 * HOUR);
  const [create] = sessionCreates();
  expect(create?.body.get("success_url")).toBe(
    "https://api.example.test/api/v1/subscriptions/checkout/payer?outcome=paid",
  );
  expect(create?.body.get("cancel_url")).toBe(
    "https://api.example.test/api/v1/subscriptions/checkout/payer?outcome=canceled",
  );
  expect(create?.body.has("ui_mode")).toBe(false);
});

test("switching presentation for the same plan closes the previous session before creating one", async () => {
  const org = await seedOrganization();
  const embeddedKey = randomUUID();
  const embedded = await submit(org, "plus_monthly", embeddedKey, "embedded").result;
  if (!("sessionId" in embedded)) throw new Error("expected an embedded checkout");
  requests.length = 0;

  const sharedKey = randomUUID();
  const shared = await submit(org, "plus_monthly", sharedKey, "shared").result;
  expect(shared).toMatchObject({ status: "open", presentation: "shared" });
  expect(shared.commandId).not.toBe(embedded.commandId);
  expect(sessions.get(embedded.sessionId)?.status).toBe("expired");
  expect(providerWrites().map((request) => request.path)).toEqual([
    `/v1/checkout/sessions/${embedded.sessionId}/expire`,
    "/v1/checkout/sessions",
  ]);
  expect(await commandRow(embedded.commandId)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_SUPERSEDED_BY_PRESENTATION_CHANGE",
  });
  expect((await operations.findPendingCheckout(org.organizationId))?.id).toBe(shared.commandId);

  // Retrying either intent is idempotent: the shared link is stable and the closed form stays closed.
  requests.length = 0;
  expect(await submit(org, "plus_monthly", sharedKey, "shared").result).toEqual(shared);
  expect(await submit(org, "plus_monthly", embeddedKey, "embedded").result).toEqual({
    status: "expired",
    commandId: embedded.commandId,
    checkoutUrl: null,
  });
  expect(providerWrites()).toEqual([]);
  // A key is bound to its presentation; reusing it for another one is a conflict.
  await expect(submit(org, "plus_monthly", sharedKey, "embedded").result).rejects.toMatchObject({
    code: "SUBSCRIPTION_CHECKOUT_REJECTED",
    context: { reason: "checkout_replay_mismatch" },
  });
  // The default hosted presentation also supersedes the shared link.
  const hosted = await submit(org, "plus_monthly", randomUUID()).result;
  expect(hosted).toEqual({
    status: "open",
    commandId: hosted.commandId,
    checkoutUrl: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
  });
  expect(await commandRow(shared.commandId)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_SUPERSEDED_BY_PRESENTATION_CHANGE",
  });
});

test("switching presentation never starts a second purchase after the pending one completed", async () => {
  const org = await seedOrganization();
  const pending = await seedCheckout(org, "plus_monthly", { dispatched: true });
  openSession(org, pending.command.id, "complete");
  await expect(submit(org, "plus_monthly", randomUUID(), "shared").result).rejects.toBeDefined();
  expect(sessionCreates()).toEqual([]);
});

test("checkout contracts bind return behavior to their presentation", () => {
  const id = randomUUID();
  const organizationId = randomUUID();
  const identity = { app: "eliza-cloud", organization_id: organizationId, command_id: id };
  const base = {
    version: 1,
    catalogVersion: "v1",
    planKey: "plus_monthly",
    accountId: ACCOUNT_ID,
    expectedLivemode: false,
    priceId: "price_plus",
    productId: "prod_plus",
  };
  const params = {
    mode: "subscription",
    currency: "usd",
    customer: "cus_contract",
    client_reference_id: id,
    line_items: [{ price: "price_plus", quantity: 1 }],
    payment_method_types: ["card"],
    allow_promotion_codes: false,
    automatic_tax: { enabled: false },
    metadata: identity,
    subscription_data: { metadata: identity },
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };
  const payer = (outcome: string) =>
    `https://api.example.test/api/v1/subscriptions/checkout/payer?outcome=${outcome}`;
  const valid = (value: unknown) => contracts.checkoutContractSchema.safeParse(value).success;
  const embedded = { ui_mode: "embedded", redirect_on_completion: "never" };
  const sharedReturns = { success_url: payer("paid"), cancel_url: payer("canceled") };
  expect(valid({ ...base, presentation: "embedded", params: { ...params, ...embedded } })).toBe(
    true,
  );
  expect(valid({ ...base, presentation: "shared", params: { ...params, ...sharedReturns } })).toBe(
    true,
  );
  // An embedded form never carries a redirect target, and must never redirect.
  expect(
    valid({
      ...base,
      presentation: "embedded",
      params: { ...params, ...embedded, success_url: payer("paid") },
    }),
  ).toBe(false);
  expect(
    valid({
      ...base,
      presentation: "embedded",
      params: { ...params, ui_mode: "embedded", redirect_on_completion: "always" },
    }),
  ).toBe(false);
  // Shared returns are only the fixed public payer page, never a billing page with a session id.
  expect(
    valid({
      ...base,
      presentation: "shared",
      params: {
        ...params,
        success_url:
          "https://api.example.test/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}",
        cancel_url: payer("canceled"),
      },
    }),
  ).toBe(false);
  expect(
    valid({
      ...base,
      presentation: "shared",
      params: { ...params, success_url: payer("paid"), cancel_url: "https://evil.example/x" },
    }),
  ).toBe(false);
  // Hosted (absent presentation) contracts cannot carry embedded mode or omit return URLs.
  expect(valid({ ...base, params: { ...params, ...embedded } })).toBe(false);
  expect(valid({ ...base, params })).toBe(false);
});

test("recovery settles provider-expired checkouts and closes payable sessions of fenced organizations", async () => {
  const stale = await seedOrganization();
  const staleCheckout = await seedCheckout(stale, "plus_monthly", {
    createdAt: new Date(Date.now() - (23 * HOUR + 30 * 60 * 1000)),
    dispatched: true,
  });
  openSession(stale, staleCheckout.command.id, "expired");
  const fenced = await seedOrganization();
  const fencedCheckout = await seedCheckout(fenced, "pro_monthly", { dispatched: true });
  const fencedSession = openSession(fenced, fencedCheckout.command.id, "open");
  await query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [
    fenced.organizationId,
  ]);
  const live = await seedOrganization();
  const liveCheckout = await seedCheckout(live, "plus_monthly", { dispatched: true });
  const liveSession = openSession(live, liveCheckout.command.id, "open");

  const result = await checkout.recoverStaleSubscriptionCheckouts(50);
  expect(result.settled).toBeGreaterThanOrEqual(2);
  expect(await commandRow(staleCheckout.command.id)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_EXPIRED",
  });
  expect(sessions.get(fencedSession)?.status).toBe("expired");
  expect(await commandRow(fencedCheckout.command.id)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_EXPIRED",
  });
  // A fresh, payable checkout of an unfenced organization is never touched.
  expect(sessions.get(liveSession)?.status).toBe("open");
  expect((await commandRow(liveCheckout.command.id))?.status).toBe("OUTCOME_UNKNOWN");
});

test("fencing an organization closes its payable subscription checkout", async () => {
  const org = await seedOrganization();
  const pending = await seedCheckout(org, "plus_monthly", { dispatched: true });
  const sessionId = openSession(org, pending.command.id, "open");
  expect(
    await checkout.expirePendingSubscriptionCheckoutsForOrganization(org.organizationId),
  ).toEqual({
    inspected: 1,
    settled: 1,
    completed: 0,
    pending: 0,
  });
  expect(sessions.get(sessionId)?.status).toBe("expired");
  expect(await commandRow(pending.command.id)).toEqual({
    status: "FAILED",
    error_code: "CHECKOUT_ORGANIZATION_FENCED",
  });
});

test("org checkout lookups ignore app-scoped commands sharing the organization and key", async () => {
  const org = await seedOrganization();
  const key = randomUUID();
  const execute = (sql: string) => client.getPgliteClientForTests().exec(sql);
  await execute("ALTER TABLE billing_subscription_commands DISABLE TRIGGER ALL");
  try {
    await query(
      `INSERT INTO billing_subscription_commands(id,app_id,livemode,organization_id,requested_by_user_id,kind,target_plan_key,idempotency_key,provider_idempotency_key,request_digest)
       VALUES($1,$2,false,$3,$4,'checkout','plus_monthly',$5,$6,$7)`,
      [
        randomUUID(),
        randomUUID(),
        org.organizationId,
        org.actorId,
        key,
        `app-provider-${key}`,
        "e".repeat(64),
      ],
    );
  } finally {
    await execute("ALTER TABLE billing_subscription_commands ENABLE TRIGGER ALL");
  }
  expect(await operations.findPendingCheckout(org.organizationId)).toBeUndefined();
  expect(await operations.findCommandByIdempotencyKey(org.organizationId, key)).toBeUndefined();
});

test("the portal uses the database customer, a server return URL and one locked configuration", async () => {
  const account = await seedCancellationTestAccount();
  let reauthorizations = 0;
  const reauthorize = async () => {
    reauthorizations++;
  };
  const first = await portal.createSubscriptionPortalSession(
    { organizationId: account.input.organizationId },
    reauthorize,
  );
  expect(first.url).toBe("https://billing.stripe.com/p/session/test_portal");
  expect(reauthorizations).toBe(2);
  const created = requests.filter(
    (request) => request.method === "POST" && request.path === "/v1/billing_portal/configurations",
  );
  expect(created).toHaveLength(1);
  const params = created[0]?.body;
  expect({
    subscriptionUpdate: params?.get("features[subscription_update][enabled]"),
    cancel: params?.get("features[subscription_cancel][enabled]"),
    cancelMode: params?.get("features[subscription_cancel][mode]"),
    paymentMethod: params?.get("features[payment_method_update][enabled]"),
    invoices: params?.get("features[invoice_history][enabled]"),
    customerUpdate: params?.get("features[customer_update][enabled]"),
    idempotent: created[0]?.idempotencyKey?.includes(ACCOUNT_ID),
  }).toEqual({
    subscriptionUpdate: "false",
    cancel: "true",
    cancelMode: "at_period_end",
    paymentMethod: "true",
    invoices: "true",
    customerUpdate: "false",
    idempotent: true,
  });
  const sessionRequest = requests.find((request) => request.path === "/v1/billing_portal/sessions");
  expect(sessionRequest?.body.get("customer")).toBe(account.source.stripe_customer_id);
  expect(sessionRequest?.body.get("return_url")).toBe("https://cloud.example.test/cloud/billing");
  expect(sessionRequest?.body.get("configuration")).toBe(configurations[0]?.id as string);

  // Reuse: the owned configuration is found by metadata, not recreated.
  requests.length = 0;
  await portal.createSubscriptionPortalSession(
    { organizationId: account.input.organizationId },
    reauthorize,
  );
  expect(providerWrites().map((request) => request.path)).toEqual(["/v1/billing_portal/sessions"]);

  // Drift (e.g. a Dashboard edit enabling plan switching) is re-locked before use.
  const owned = configurations[0];
  if (!owned) throw new Error("Owned portal configuration missing");
  (owned.features as Record<string, { enabled: boolean }>).subscription_update = {
    enabled: true,
  };
  requests.length = 0;
  await portal.createSubscriptionPortalSession(
    { organizationId: account.input.organizationId },
    reauthorize,
  );
  expect(providerWrites().map((request) => request.path)).toEqual([
    `/v1/billing_portal/configurations/${configurations[0]?.id}`,
    "/v1/billing_portal/sessions",
  ]);
  expect(configurations[0]?.features).toMatchObject({ subscription_update: { enabled: false } });

  // Provider lookalike hosts are never returned to the browser.
  portalUrl = "https://billing.stripe.com.attacker.example/p/session";
  await expect(
    portal.createSubscriptionPortalSession(
      { organizationId: account.input.organizationId },
      reauthorize,
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_PORTAL_UNAVAILABLE" });
});

test("the portal is not applicable without an organization Stripe subscription", async () => {
  const org = await seedOrganization();
  await expect(
    portal.createSubscriptionPortalSession({ organizationId: org.organizationId }, async () => {}),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_PORTAL_NOT_APPLICABLE" });
  expect(requests).toEqual([]);
});

test("catalog rejects multi-currency prices and briefly replays the same typed failure", async () => {
  const catalog = await import("./subscription-catalog");
  catalog.__resetSubscriptionCatalogCacheForTests();
  let reads = 0;
  let clock = 1_000_000;
  const provider = {
    async retrievePrice(priceId: string) {
      reads++;
      const plus = priceId === "price_plus";
      return {
        active: true,
        currency: "usd",
        currencyOptions: plus ? ["usd", "eur"] : ["usd"],
        unitAmount: plus ? 3000 : 10000,
        type: "recurring",
        billingScheme: "per_unit",
        transformQuantity: null,
        recurring: {
          interval: "month",
          intervalCount: 1,
          trialPeriodDays: null,
          usageType: "licensed",
        },
        productId: plus ? "prod_plus" : "prod_pro",
        livemode: false,
      };
    },
    async retrieveProduct() {
      return { active: true, deleted: false, livemode: false };
    },
  };
  const options = { env: process.env, provider, now: () => clock };
  const failure = { code: "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT" };
  await expect(catalog.getVerifiedSubscriptionPlans(options)).rejects.toMatchObject(failure);
  const firstReads = reads;
  clock += 2_000;
  await expect(catalog.getVerifiedSubscriptionPlans(options)).rejects.toMatchObject(failure);
  expect(reads).toBe(firstReads);
  clock += 10_000;
  await expect(catalog.getVerifiedSubscriptionPlans(options)).rejects.toMatchObject(failure);
  expect(reads).toBeGreaterThan(firstReads);
  catalog.__resetSubscriptionCatalogCacheForTests();
});
