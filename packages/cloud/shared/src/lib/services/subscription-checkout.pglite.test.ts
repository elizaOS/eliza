/** Exercises the real checkout journal and Stripe request construction with a controlled provider transport and migrated PGlite. */
import {
  afterAll,
  beforeAll,
  expect,
  mock,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Stripe from "stripe";
import { installCancellationTestSchema } from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = process.env.CHECKOUT_RESTART_DB ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_checkoutfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
process.env.NEXT_PUBLIC_APP_URL = "https://cloud.eliza.app";
setDefaultTimeout(120000);
let customerId: string;
let providerAccountId = "acct_checkoutfixture";
let sessions: Array<Record<string, unknown>> = [];
let calls: Array<{ params: Stripe.Checkout.SessionCreateParams; key: string }> = [];
let loseResponse = false;
let failBeforeCreation = false;
let accountBarrier: (() => Promise<void>) | undefined;
mock.module("./stripe-customer-authority", () => ({
  stripeCustomerAuthorityService: { ensure: async () => customerId },
}));
mock.module("../stripe", () => ({
  requireStripe: () => ({
    accounts: {
      retrieve: async () => {
        await accountBarrier?.();
        return { id: providerAccountId };
      },
    },
    prices: {
      retrieve: async (id: string) => ({
        id,
        active: true,
        currency: "usd",
        unit_amount: id === "price_pro" ? 10000 : 3000,
        type: "recurring",
        billing_scheme: "per_unit",
        transform_quantity: null,
        product: id === "price_pro" ? "prod_pro" : "prod_plus",
        livemode: false,
        recurring: {
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
      }),
    },
    products: { retrieve: async () => ({ active: true, livemode: false }) },
    checkout: {
      sessions: {
        list: async function* () {
          for (const session of sessions) yield session;
        },
        create: async (
          params: Stripe.Checkout.SessionCreateParams,
          options: { idempotencyKey: string },
        ) => {
          calls.push({ params, key: options.idempotencyKey });
          if (failBeforeCreation) throw new Error("provider connection failed before creation");
          const session = {
            id: `cs_test_${randomUUID().replaceAll("-", "")}`,
            mode: params.mode,
            status: "open",
            payment_status: "unpaid",
            customer: params.customer,
            subscription: null,
            invoice: null,
            client_reference_id: params.client_reference_id,
            livemode: false,
            metadata: params.metadata,
            url: "https://checkout.stripe.com/c/pay/test",
          };
          sessions.push(session);
          if (loseResponse) throw new Error("provider response lost after creation");
          return session;
        },
      },
    },
  }),
}));
let client: typeof import("../../db/client");
let submit: typeof import("./subscription-checkout").submitSubscriptionCheckout;
let resetCatalog: typeof import("./subscription-catalog").__resetSubscriptionCatalogCacheForTests;
beforeAll(async () => {
  client = await import("../../db/client");
  if (process.env.CHECKOUT_RESTART_PHASE !== "recover")
    await installCancellationTestSchema((sql) => client.getPgliteClientForTests().exec(sql));
  submit = (await import("./subscription-checkout")).submitSubscriptionCheckout;
  resetCatalog = (await import("./subscription-catalog")).__resetSubscriptionCatalogCacheForTests;
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function seed() {
  const organizationId = randomUUID(),
    actorId = randomUUID();
  customerId = `cus_${organizationId.replaceAll("-", "")}`;
  const db = client.getPgliteClientForTests();
  await db.query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
    organizationId,
    customerId,
  ]);
  await db.query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'owner')", [
    actorId,
    organizationId,
  ]);
  sessions = [];
  calls = [];
  loseResponse = false;
  failBeforeCreation = false;
  accountBarrier = undefined;
  providerAccountId = "acct_checkoutfixture";
  process.env.STRIPE_SECRET_KEY = "sk_test_checkoutfixture";
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
  resetCatalog();
  return {
    organizationId,
    actorId,
    planKey: "plus_monthly" as const,
    idempotencyKey: randomUUID(),
  };
}
test("lost provider response recovers the same session without a second purchase", async () => {
  const input = await seed();
  loseResponse = true;
  await expect(submit(input, async () => {})).rejects.toThrow("response lost");
  loseResponse = false;
  const recovered = await submit(input, async () => {});
  expect(recovered.status).toBe("open");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.params).toMatchObject({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: "price_plus", quantity: 1 }],
    allow_promotion_codes: false,
  });
  expect((await submit({ ...input, idempotencyKey: randomUUID() }, async () => {})).status).toBe(
    "open",
  );
  expect(calls).toHaveLength(1);
});
test("exact checkout key cannot be replayed for a different actor or plan", async () => {
  const input = await seed();
  const original = await submit(input, async () => {});
  for (const change of [{ actorId: randomUUID() }, { planKey: "pro_monthly" as const }]) {
    await expect(submit({ ...input, ...change }, async () => {})).rejects.toThrow(
      "Subscription checkout requires reconciliation",
    );
  }
  expect(calls).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect((await submit(input, async () => {})).commandId).toBe(original.commandId);
});

test("a freshly authorized manager on another device resumes the same pending purchase", async () => {
  const input = await seed();
  const original = await submit(input, async () => {});
  const actorId = randomUUID();
  await client
    .getPgliteClientForTests()
    .query("INSERT INTO users(id,organization_id,role) VALUES($1,$2,'admin')", [
      actorId,
      input.organizationId,
    ]);
  let checks = 0;
  const resumed = await submit({ ...input, actorId, idempotencyKey: randomUUID() }, async () => {
    checks++;
  });
  expect(checks).toBeGreaterThan(0);
  expect(resumed).toEqual(original);
  expect(calls).toHaveLength(1);
  expect(sessions).toHaveLength(1);
});

test("an unknown checkout beyond the safe provider retry window never redispatches", async () => {
  const input = await seed();
  failBeforeCreation = true;
  await expect(submit(input, async () => {})).rejects.toThrow("before creation");
  const original = structuredClone(calls[0]);
  const repository = (await import("../../db/repositories/subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  const command = await repository.findPendingCheckout(input.organizationId);
  if (!command?.provider_started_at) throw new Error("Expected durable dispatch fence");
  failBeforeCreation = false;
  try {
    setSystemTime(new Date(command.provider_started_at.getTime() + 23 * 60 * 60 * 1000));
    await expect(submit(input, async () => {})).rejects.toThrow(
      "Subscription checkout requires reconciliation",
    );
    expect(calls).toEqual([original]);
    expect(sessions).toHaveLength(0);
    expect((await repository.findPendingCheckout(input.organizationId))?.checkout_contract).toEqual(
      command.checkout_contract,
    );
  } finally {
    setSystemTime();
  }
});

test("lost authorization before provider dispatch creates no Checkout session", async () => {
  const input = await seed();
  let checks = 0;
  await expect(
    submit(input, async () => {
      if (++checks === 3) throw new Error("membership revoked");
    }),
  ).rejects.toThrow("membership revoked");
  expect(calls).toHaveLength(0);
});
test("verified expiry releases the purchase fence before a fresh checkout", async () => {
  const input = await seed();
  await submit(input, async () => {});
  sessions[0]!.status = "expired";
  expect((await submit(input, async () => {})).status).toBe("expired");
  expect((await submit({ ...input, idempotencyKey: randomUUID() }, async () => {})).status).toBe(
    "open",
  );
  expect(calls).toHaveLength(2);
});

test("cold-cache recovery preserves the original approved checkout after binding rotation", async () => {
  const input = await seed();
  failBeforeCreation = true;
  await expect(submit(input, async () => {})).rejects.toThrow("before creation");
  expect(sessions).toHaveLength(0);
  const original = calls[0]!;
  // The service itself is stateless. Clear its provider-verification cache
  // to model a fresh worker resolving configuration against the same journal.
  resetCatalog();
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plusRotated";
  failBeforeCreation = false;
  const recovered = await submit(input, async () => {});
  expect(recovered.status).toBe("open");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.key).toBe(original.key);
  expect(calls[1]!.params).toEqual(original.params);
  expect(sessions).toHaveLength(1);
});

test("binding rotation after a lost response recovers the existing checkout without dispatch", async () => {
  const input = await seed();
  loseResponse = true;
  await expect(submit(input, async () => {})).rejects.toThrow("response lost");
  resetCatalog();
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plusRotated";
  loseResponse = false;
  const recovered = await submit(input, async () => {});
  expect(recovered.status).toBe("open");
  expect(calls).toHaveLength(1);
  expect(sessions).toHaveLength(1);
});

test("same-account credential rotation replays the original contract", async () => {
  const input = await seed();
  failBeforeCreation = true;
  await expect(submit(input, async () => {})).rejects.toThrow("before creation");
  const original = calls[0]!;
  process.env.STRIPE_SECRET_KEY = "sk_test_rotatedcredential";
  failBeforeCreation = false;
  expect((await submit(input, async () => {})).status).toBe("open");
  expect(calls[1]).toEqual(original);
});

test("changed provider account denies replay before creation", async () => {
  const input = await seed();
  failBeforeCreation = true;
  await expect(submit(input, async () => {})).rejects.toThrow("before creation");
  providerAccountId = "acct_other";
  failBeforeCreation = false;
  await expect(submit(input, async () => {})).rejects.toThrow("authority changed");
  expect(calls).toHaveLength(1);
  expect(sessions).toHaveLength(0);
});

async function legacyCommand(input: Awaited<ReturnType<typeof seed>>) {
  return (
    await (
      await import("../../db/repositories/subscription-billing-operations")
    ).subscriptionBillingOperationsRepository.enqueueCommand({
      organizationId: input.organizationId,
      requestedByUserId: input.actorId,
      kind: "checkout",
      subscriptionId: null,
      targetPlanKey: input.planKey,
      expectedSubscriptionRevision: null,
      idempotencyKey: input.idempotencyKey,
      providerIdempotencyKey: randomUUID(),
      requestDigest: "a".repeat(64),
      now: new Date(),
    })
  ).value;
}

test("legacy prepared command without original contract remains unavailable without provider creation", async () => {
  const input = await seed();
  await legacyCommand(input);
  await expect(submit(input, async () => {})).rejects.toThrow("Original checkout authority");
  expect(calls).toHaveLength(0);
  expect(sessions).toHaveLength(0);
});

test("stored contract cannot be replaced and another command cannot adopt it", async () => {
  const input = await seed();
  await submit(input, async () => {});
  const repo = (await import("../../db/repositories/subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  const command = await repo.findPendingCheckout(input.organizationId);
  if (!command?.checkout_contract) throw new Error("Expected persisted checkout contract");
  await expect(
    client
      .getPgliteClientForTests()
      .query("UPDATE billing_subscription_commands SET checkout_contract = NULL WHERE id=$1", [
        command.id,
      ]),
  ).rejects.toThrow("immutable");
  const other = await seed();
  await expect(
    repo.enqueueCommand({
      id: randomUUID(),
      organizationId: other.organizationId,
      requestedByUserId: other.actorId,
      kind: "checkout",
      subscriptionId: null,
      targetPlanKey: other.planKey,
      expectedSubscriptionRevision: null,
      idempotencyKey: other.idempotencyKey,
      providerIdempotencyKey: randomUUID(),
      requestDigest: "b".repeat(64),
      checkoutContract: command.checkout_contract.payload,
      now: new Date(),
    }),
  ).rejects.toThrow("Checkout contract differs from command authority");
  expect(await repo.findPendingCheckout(other.organizationId)).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test("malformed stored payload or digest denies dispatch", async () => {
  const source = await seed();
  await submit(source, async () => {});
  const repo = (await import("../../db/repositories/subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  const original = await repo.findPendingCheckout(source.organizationId);
  if (!original?.checkout_contract) throw new Error("Expected original contract");
  for (const malformed of [
    { payload: {}, digest: "b".repeat(64) },
    {
      ...original.checkout_contract,
      payload: {
        ...original.checkout_contract.payload,
        params: { ...original.checkout_contract.payload.params, cancel_url: "invalid" },
      },
    },
    { ...original.checkout_contract, digest: "c".repeat(64) },
  ]) {
    const input = await seed();
    const command = await legacyCommand(input);
    await client
      .getPgliteClientForTests()
      .query("UPDATE billing_subscription_commands SET checkout_contract=$1::jsonb WHERE id=$2", [
        JSON.stringify(malformed),
        command.id,
      ]);
    await expect(submit(input, async () => {})).rejects.toThrow("Original checkout authority");
    expect(calls).toHaveLength(0);
  }
});

test.skipIf(!process.env.CHECKOUT_RESTART_PHASE)("checkout restart child", async () => {
  const path = process.env.CHECKOUT_RESTART_RECEIPT;
  if (!path) throw new Error("Expected restart receipt path");
  if (process.env.CHECKOUT_RESTART_PHASE === "prepare") {
    const input = await seed();
    failBeforeCreation = true;
    await expect(submit(input, async () => {})).rejects.toThrow("before creation");
    writeFileSync(path, JSON.stringify({ input, original: calls[0] }));
  } else {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    customerId = `cus_${saved.input.organizationId.replaceAll("-", "")}`;
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plusRotated";
    expect((await submit(saved.input, async () => {})).status).toBe("open");
    expect(calls).toEqual([saved.original]);
    expect(sessions).toHaveLength(1);
  }
});

test("a separate worker process replays the persisted original checkout after rotation", () => {
  const directory = mkdtempSync(join(tmpdir(), "checkout-restart-"));
  try {
    for (const phase of ["prepare", "recover"]) {
      const result = spawnSync(
        process.execPath,
        ["test", import.meta.path, "--test-name-pattern", "^checkout restart child$"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 120000,
          env: {
            ...process.env,
            CHECKOUT_RESTART_DB: `pglite://${join(directory, "database")}`,
            CHECKOUT_RESTART_PHASE: phase,
            CHECKOUT_RESTART_RECEIPT: join(directory, "receipt.json"),
          },
        },
      );
      expect({ phase, status: result.status, output: result.stdout + result.stderr }).toMatchObject(
        { phase, status: 0 },
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment-mode change denies original checkout replay", async () => {
  const input = await seed();
  failBeforeCreation = true;
  await expect(submit(input, async () => {})).rejects.toThrow("before creation");
  process.env.ENVIRONMENT = "production";
  failBeforeCreation = false;
  try {
    await expect(submit(input, async () => {})).rejects.toThrow("authority changed");
  } finally {
    process.env.ENVIRONMENT = "local";
  }
  expect(calls).toHaveLength(1);
  expect(sessions).toHaveLength(0);
});

test("concurrent same-key checkout adopts the immutable winning command", async () => {
  const input = await seed();
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  accountBarrier = async () => {
    if (++arrived === 2) {
      accountBarrier = undefined;
      release();
    }
    await barrier;
  };
  const results = await Promise.allSettled([
    submit(input, async () => {}),
    submit(input, async () => {}),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  const rows = await client
    .getPgliteClientForTests()
    .query<{ checkout_contract: { payload: { params: unknown } } }>(
      "SELECT checkout_contract FROM billing_subscription_commands WHERE organization_id=$1",
      [input.organizationId],
    );
  expect(rows.rows).toHaveLength(1);
  expect(sessions).toHaveLength(1);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls)
    expect(call.params).toEqual(rows.rows[0].checkout_contract.payload.params);
});

test("winning checkout cannot absorb a conflicting actor, plan, digest or provider key", async () => {
  const input = await seed();
  await submit(input, async () => {});
  const repository = (await import("../../db/repositories/subscription-billing-operations"))
    .subscriptionBillingOperationsRepository;
  const winner = await repository.findPendingCheckout(input.organizationId);
  if (!winner?.checkout_contract) throw new Error("Expected winning checkout");
  for (const change of [
    { requestedByUserId: randomUUID() },
    { targetPlanKey: "pro_monthly" as const },
    { requestDigest: "d".repeat(64) },
    { providerIdempotencyKey: "another-provider-key" },
  ]) {
    const id = randomUUID();
    const payload = winner.checkout_contract.payload;
    const targetPlanKey = "targetPlanKey" in change ? change.targetPlanKey : "plus_monthly";
    await expect(
      repository.enqueueCommand({
        id,
        organizationId: input.organizationId,
        requestedByUserId: input.actorId,
        kind: "checkout",
        subscriptionId: null,
        targetPlanKey,
        expectedSubscriptionRevision: null,
        idempotencyKey: input.idempotencyKey,
        providerIdempotencyKey: winner.provider_idempotency_key,
        requestDigest: winner.request_digest,
        checkoutContract: {
          ...payload,
          planKey: targetPlanKey,
          params: {
            ...payload.params,
            client_reference_id: id,
            metadata: { ...payload.params.metadata, command_id: id },
            subscription_data: {
              metadata: { ...payload.params.subscription_data.metadata, command_id: id },
            },
          },
        },
        now: new Date(),
        ...change,
      }),
    ).rejects.toThrow("idempotency replay differs");
  }
  const stored = await repository.findPendingCheckout(input.organizationId);
  expect(stored?.checkout_contract).toEqual(winner.checkout_contract);
  expect(sessions).toHaveLength(1);
});
