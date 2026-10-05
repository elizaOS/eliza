/** Exercises signed owner-session HTTP, durable catalog recovery and real PostgreSQL migrations with controlled Stripe transport. */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import type {
  AppBillingAdministration,
  AppBillingAdminOperation,
  AppBillingAdminPlan,
  AppBillingMerchant,
  CreateAppBillingPlanRequest,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { AppBillingAdminClient } from "@elizaos/cloud-sdk/app-billing-admin";
import {
  closeAdminTest,
  databaseUrl,
  db,
  env,
  ids,
  otherToken,
  provider,
  request,
  routes,
  setupAdminTest,
  token,
} from "./admin-test-harness";

setDefaultTimeout(30000);
let merchant: AppBillingMerchant;
let plan: AppBillingAdminPlan;
function planInput(
  overrides: Partial<CreateAppBillingPlanRequest> = {},
): CreateAppBillingPlanRequest {
  return {
    clientRegistrationId: ids.registration,
    idempotencyKey: randomUUID(),
    merchantId: merchant.id,
    productFamilyKey: "main",
    planKey: "basic",
    name: "Basic",
    amountCents: 3000,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    seats: { minimum: 1, maximum: 10 },
    trial: { days: 7, allowanceUsd: "2.000000" },
    allowanceUsd: "10.000000",
    featureKeys: ["inference"],
    expiredAccess: "read_only",
    rateLimits: {
      completionsRpm: 60,
      embeddingsRpm: 60,
      standardRpm: 60,
      strictRpm: 10,
    },
    ...overrides,
  };
}
describe.skipIf(!databaseUrl)(
  "app billing merchant and catalog PostgreSQL HTTP",
  () => {
    beforeAll(setupAdminTest);
    afterAll(closeAdminTest);
    test("refund HTTP rejects foreign owners, missing receipts and caller-supplied provider identity before writes", async () => {
      const before = provider.requests.length;
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        paidPeriodId: randomUUID(),
        amountCents: 500,
        accessPolicy: "preserve",
        confirmation: "refund_original_payment_preserve_access",
      };
      expect(
        (await request("/refunds", input, otherToken)).response.status,
      ).toBe(403);
      expect((await request("/refunds", input)).response.status).toBe(403);
      expect(
        (await request("/refunds", { ...input, invoiceId: "in_foreign" }))
          .response.status,
      ).toBe(400);
      expect(provider.requests.length).toBe(before);
    });
    test("merchant receipt pages and previews retain current owner and registration authority", async () => {
      const before = provider.requests.length;
      const page = await request(
        `/paid-periods?clientRegistrationId=${ids.registration}`,
      );
      expect(page.response.status).toBe(200);
      expect(page.body.data).toMatchObject({
        appId: ids.app,
        clientRegistrationId: ids.registration,
        environment: "test",
        items: [],
        nextCursor: null,
      });
      expect(
        (
          await request(
            `/paid-periods?clientRegistrationId=${ids.registration}`,
            undefined,
            otherToken,
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await request(
            `/paid-periods?clientRegistrationId=${ids.registration}&cursor=${randomUUID()}`,
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await request("/refunds/preview", {
            clientRegistrationId: ids.registration,
            paidPeriodId: randomUUID(),
          })
        ).response.status,
      ).toBe(403);
      expect(
        (
          await request("/refunds/preview", {
            clientRegistrationId: ids.registration,
            paidPeriodId: randomUUID(),
            environment: "live",
          })
        ).response.status,
      ).toBe(400);
      expect(provider.requests.length).toBe(before);
    });
    test("rejects another owner and client-supplied environment before provider writes", async () => {
      const before = provider.requests.length;
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "create_connected",
        country: "US",
      };
      const foreign = await request("/merchants", input, otherToken);
      expect(foreign.response.status).toBe(403);
      const extra = await request("/merchants", { ...input, livemode: true });
      expect(extra.response.status).toBe(400);
      expect(provider.requests).toHaveLength(before);
    });
    test("registers one verified merchant per durable intent without changing infrastructure credit", async () => {
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "create_connected",
        country: "US",
      };
      const created = await request<AppBillingAdminOperation>(
        "/merchants",
        input,
      );
      expect(created.response.status).toBe(200);
      if (
        created.body.data.status !== "succeeded" ||
        !created.body.data.merchant
      )
        throw new Error(JSON.stringify(created.body));
      merchant = created.body.data.merchant;
      expect(merchant.connectionStatus).toBe("ready");
      const retry = await request<AppBillingAdminOperation>(
        "/merchants",
        input,
      );
      expect(retry.body.data.id).toBe(created.body.data.id);
      expect(
        provider.requests.filter(
          (r) => r.method === "POST" && r.path === "/v1/accounts",
        ),
      ).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT credit_balance::text FROM organizations WHERE id=$1",
            [ids.org],
          )
        ).rows,
      ).toEqual([{ credit_balance: "42.000000" }]);
    });
    test("browser SDK reads the registered administration route without exposing provider account handles", async () => {
      const fetchImpl = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) =>
          routes.request(input, init, env),
        { preconnect: fetch.preconnect },
      );
      const sdk = new AppBillingAdminClient(
        new CloudApiClient("https://cloud.eliza.app", undefined, {
          fetchImpl,
          defaultHeaders: { cookie: `eliza-test-session=${token}` },
        }),
        ids.app,
      );
      const overview = await sdk.overview();
      expect(overview.success).toBe(true);
      expect(
        overview.data.merchants.find((row) => row.id === merchant.id)
          ?.connectionStatus,
      ).toBe("ready");
      expect(JSON.stringify(overview)).not.toContain("acct_created");
    });
    test("creates verified unpublished seven-day terms and protects published revisions", async () => {
      const created = await request<AppBillingAdminOperation>(
        "/plans",
        planInput(),
      );
      expect(created.response.status).toBe(200);
      if (created.body.data.status !== "succeeded" || !created.body.data.plan)
        throw new Error(JSON.stringify(created.body));
      plan = created.body.data.plan;
      expect(plan.state).toBe("verified");
      expect(plan.trial.days).toBe(7);
      const result = await request<AppBillingAdminPlan>("/plans/publish", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        planRevisionId: plan.id,
      });
      expect(result.response.status).toBe(200);
      expect(result.body.data.state).toBe("published");
      await expect(
        db.query(
          "UPDATE app_billing_plan_revisions SET amount_cents=1 WHERE id=$1",
          [plan.id],
        ),
      ).rejects.toThrow("immutable");
    });
    test("adopts a price only after its immutable terms are verified in the owned merchant account", async () => {
      const [binding] = (
        await db.query(
          "SELECT stripe_price_id,stripe_product_id FROM app_billing_plan_revisions WHERE id=$1",
          [plan.id],
        )
      ).rows;
      const before = provider.priceCreates();
      const adopted = await request<AppBillingAdminOperation>("/plans/adopt", {
        ...planInput({ planKey: "adopted" }),
        priceReference: binding.stripe_price_id,
        productReference: binding.stripe_product_id,
      });
      expect(adopted.response.status).toBe(200);
      expect(adopted.body.data.status).toBe("succeeded");
      expect(provider.priceCreates()).toBe(before);
      await expect(
        db.query(
          "UPDATE app_billing_catalog_verifications SET object_digest=$1 WHERE plan_revision_id=$2",
          ["a".repeat(64), plan.id],
        ),
      ).rejects.toThrow("immutable");
    });
    test("provider price drift and revoked app review prevent publication", async () => {
      provider.state.badPrice = true;
      const bad = await request("/plans/verify", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        planRevisionId: plan.id,
      });
      expect(bad.response.status).not.toBe(200);
      provider.state.badPrice = false;
      await db.query("UPDATE apps SET review_status='draft' WHERE id=$1", [
        ids.app,
      ]);
      const fenced = await request("/plans/publish", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        planRevisionId: plan.id,
      });
      expect(fenced.response.status).toBe(409);
      await db.query("UPDATE apps SET review_status='approved' WHERE id=$1", [
        ids.app,
      ]);
    });
    test("recovers lost price-creation response without duplicating provider creation", async () => {
      provider.state.losePriceResponse = true;
      const before = provider.priceCreates();
      const lost = await request("/plans", planInput({ planKey: "recovered" }));
      expect(lost.response.status).not.toBe(200);
      const overview = await request<AppBillingAdministration>("");
      const pending = overview.body.data.operations.find(
        (row) => row.action === "plan_create",
      );
      if (!pending) throw new Error("Missing durable pending creation");
      expect(pending.environment).toBe("test");
      expect(pending.clientRegistrationId).toBe(ids.registration);
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [pending.id],
      );
      const recovered = await request<AppBillingAdminOperation>(
        `/operations/${pending.id}/recover`,
        {},
      );
      expect(recovered.response.status).toBe(200);
      expect(recovered.body.data.status).toBe("succeeded");
      expect(provider.priceCreates() - before).toBe(1);
    });
    test("rechecks current membership despite a previously valid signed session", async () => {
      await db.query("UPDATE users SET role='member' WHERE id=$1", [ids.user]);
      const before = provider.requests.length;
      const result = await request("/merchants/refresh", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        merchantId: merchant.id,
      });
      expect(result.response.status).toBe(403);
      expect(provider.requests).toHaveLength(before);
      await db.query("UPDATE users SET role='owner' WHERE id=$1", [ids.user]);
    });
    test("adopts only the actor's saved creator connection and gates the first-party platform account", async () => {
      const foreignId = randomUUID();
      const ownId = randomUUID();
      await db.query(
        "INSERT INTO stripe_connect_accounts(id,user_id,stripe_connect_account_id) VALUES($1,$2,'acct_foreign'),($3,$4,'acct_creator')",
        [foreignId, ids.otherUser, ownId, ids.user],
      );
      const forbidden = await request("/merchants", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "adopt_creator",
        creatorConnectionId: foreignId,
      });
      expect(forbidden.response.status).toBe(403);
      const adopted = await request<AppBillingAdminOperation>("/merchants", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "adopt_creator",
        creatorConnectionId: ownId,
      });
      expect(adopted.response.status).toBe(200);
      expect(adopted.body.data.status).toBe("succeeded");
      env.STRIPE_PLATFORM_BILLING_ORGANIZATION_ID = ids.otherOrg;
      const platformDenied = await request("/merchants", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "platform",
      });
      expect(platformDenied.response.status).toBe(403);
      env.STRIPE_PLATFORM_BILLING_ORGANIZATION_ID = ids.org;
      const platform = await request<AppBillingAdminOperation>("/merchants", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "platform",
      });
      expect(platform.response.status).toBe(200);
      expect(
        (
          await db.query(
            "SELECT stripe_account_id FROM billing_merchants WHERE provider_account_key='platform'",
          )
        ).rows,
      ).toEqual([{ stripe_account_id: "acct_platform" }]);
    });
    test("an adopted creator connection cannot change provider identity across recovery", async () => {
      const [connection] = (
        await db.query(
          "SELECT id FROM stripe_connect_accounts WHERE user_id=$1",
          [ids.user],
        )
      ).rows;
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "adopt_creator",
        creatorConnectionId: connection.id,
      };
      provider.state.failAccountRead = true;
      const unavailable = await request("/merchants", input);
      expect(unavailable.response.status).toBe(500);
      provider.state.failAccountRead = false;
      const [command] = (
        await db.query(
          "SELECT id,request_payload FROM billing_subscription_commands WHERE idempotency_key=$1",
          [input.idempotencyKey],
        )
      ).rows;
      expect(command.request_payload.providerAccountId).toBe("acct_creator");
      await db.query(
        "UPDATE stripe_connect_accounts SET stripe_connect_account_id='acct_replaced' WHERE id=$1",
        [connection.id],
      );
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [command.id],
      );
      const before = provider.requests.length;
      const refused = await request(`/operations/${command.id}/recover`, {});
      expect(refused.response.status).toBe(403);
      expect(provider.requests).toHaveLength(before);
      expect(
        (
          await db.query(
            "SELECT id FROM billing_merchants WHERE stripe_account_id='acct_replaced'",
          )
        ).rows,
      ).toHaveLength(0);
      await db.query(
        "UPDATE stripe_connect_accounts SET stripe_connect_account_id='acct_creator' WHERE id=$1",
        [connection.id],
      );
    });
    test("retains pending onboarding recovery and clears it once current capabilities are ready", async () => {
      provider.state.charges = false;
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        merchantId: merchant.id,
      };
      const restricted = await request<AppBillingMerchant>(
        "/merchants/refresh",
        input,
      );
      expect(restricted.response.status).toBe(200);
      expect(restricted.body.data.connectionStatus).toBe("restricted");
      const onboarding = await request<AppBillingAdminOperation>(
        "/merchants/onboarding",
        { ...input, idempotencyKey: randomUUID() },
      );
      expect(onboarding.response.status).toBe(200);
      expect(onboarding.body.data.status).toBe("requires_action");
      const overview = await request<AppBillingAdministration>("");
      expect(
        overview.body.data.operations.find(
          (row) => row.id === onboarding.body.data.id,
        )?.status,
      ).toBe("requires_action");
      provider.state.charges = true;
      const refreshed = await request<AppBillingMerchant>(
        "/merchants/refresh",
        { ...input, idempotencyKey: randomUUID() },
      );
      expect(refreshed.response.status).toBe(200);
      merchant = refreshed.body.data;
      const completed = await request<AppBillingAdminOperation>(
        `/operations/${onboarding.body.data.id}/recover`,
        {},
      );
      expect(completed.response.status).toBe(200);
      expect(completed.body.data.status).toBe("succeeded");
    });
    test("a provider result cannot apply after current owner membership is revoked during I/O", async () => {
      provider.state.afterAccountCreate = async () => {
        await db.query("UPDATE users SET role='member' WHERE id=$1", [
          ids.user,
        ]);
      };
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        mode: "create_connected",
        country: "US",
      };
      const denied = await request("/merchants", input);
      expect(denied.response.status).toBe(403);
      provider.state.afterAccountCreate = null;
      await db.query("UPDATE users SET role='owner' WHERE id=$1", [ids.user]);
      const [command] = (
        await db.query(
          "SELECT id,status FROM billing_subscription_commands WHERE idempotency_key=$1",
          [input.idempotencyKey],
        )
      ).rows;
      expect(command.status).toBe("OUTCOME_UNKNOWN");
      expect(
        (
          await db.query("SELECT id FROM billing_merchants WHERE id=$1", [
            command.id,
          ])
        ).rows,
      ).toHaveLength(0);
      await db.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [command.id],
      );
      const before = provider.requests.filter(
        (row) => row.method === "POST" && row.path === "/v1/accounts",
      ).length;
      const recovered = await request<AppBillingAdminOperation>(
        `/operations/${command.id}/recover`,
        {},
      );
      expect(recovered.response.status).toBe(200);
      expect(
        provider.requests.filter(
          (row) => row.method === "POST" && row.path === "/v1/accounts",
        ),
      ).toHaveLength(before);
    });
    test("retirement and disconnect remain available when sales are fenced and preserve plan handles", async () => {
      await db.query("UPDATE apps SET review_status='draft' WHERE id=$1", [
        ids.app,
      ]);
      const retired = await request<AppBillingAdminPlan>("/plans/retire", {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        planRevisionId: plan.id,
      });
      expect(retired.response.status).toBe(200);
      expect(retired.body.data.state).toBe("retired");
      const input = {
        clientRegistrationId: ids.registration,
        idempotencyKey: randomUUID(),
        merchantId: merchant.id,
        expectedRevision: merchant.revision,
        confirmation: "disable_new_sales_for_merchant",
      };
      const result = await request<{
        merchant: AppBillingMerchant;
        existingBillingContinues: boolean;
      }>("/merchants/disconnect", input);
      expect(result.response.status).toBe(200);
      expect(result.body.data.existingBillingContinues).toBe(true);
      expect(result.body.data.merchant.enabled).toBe(false);
      const stale = await request("/merchants/disconnect", {
        ...input,
        idempotencyKey: randomUUID(),
      });
      expect(stale.response.status).toBe(409);
      expect(
        (
          await db.query(
            "SELECT stripe_price_id FROM app_billing_plan_revisions WHERE id=$1",
            [plan.id],
          )
        ).rows[0].stripe_price_id,
      ).toMatch(/^price_/);
    });
  },
);
