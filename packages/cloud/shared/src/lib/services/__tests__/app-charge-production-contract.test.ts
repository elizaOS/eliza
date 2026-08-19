/**
 * Exercises app-charge creation and settlement against the real services and
 * durable PGlite rows. Provider transport is outside this deterministic lane;
 * callback transport and cross-tenant projection have their own boundary tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { cryptoPayments } from "../../../db/schemas/crypto-payments";
import { appChargeCallbackOutbox } from "../../../db/schemas/crypto-settlement-outbox";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
const APP_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000003";

let dbRead: typeof import("../../../db/client").dbRead;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let requests: typeof import("../app-charge-requests").appChargeRequestsService;
let settlement: typeof import("../app-charge-settlement").appChargeSettlementService;
let pgliteReady = true;

async function createCharge(
  overrides: Partial<import("../app-charge-requests").CreateAppChargeRequestParams> = {},
) {
  return requests.create({
    appId: APP_ID,
    creatorUserId: USER_ID,
    creatorOrganizationId: ORG_ID,
    amountUsd: 5,
    description: "Production app-charge contract",
    providers: ["stripe", "oxapay"],
    ...overrides,
  });
}

async function durableCharge(id: string) {
  const [row] = await dbRead.select().from(cryptoPayments).where(eq(cryptoPayments.id, id));
  return row;
}

async function expectSettlementCode(operation: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ElizaError);
  expect((caught as ElizaError).code).toBe(code);
}

beforeAll(async () => {
  try {
    ({
      closeDatabaseConnectionsForTests: closeDb,
      dbRead,
      dbWrite,
    } = await import("../../../db/client"));
    ({ appChargeRequestsService: requests } = await import("../app-charge-requests"));
    ({ appChargeSettlementService: settlement } = await import("../app-charge-settlement"));

    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apps,
        cryptoPayments,
        appChargeCallbackOutbox,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values({
      id: ORG_ID,
      name: "App Charge Contract Org",
      slug: "app-charge-contract-org",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      organization_id: ORG_ID,
      steward_user_id: "app-charge-contract-user",
    });
    await dbWrite.insert(apps).values({
      id: APP_ID,
      name: "App Charge Contract App",
      description: "Approved deterministic payment contract",
      slug: "app-charge-contract-app",
      organization_id: ORG_ID,
      created_by_user_id: USER_ID,
      app_url: "https://app-charge.example.com",
      allowed_origins: ["https://app-charge.example.com"],
      review_status: "approved",
    });
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[app-charge-production-contract] PGlite setup failed; loud guard will fail",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("production app-charge durable contract", () => {
  test("PGlite schema initialized (never a silent skip)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("create persists exact amount, currency, app, creator, providers, and callback correlation", async () => {
    if (!pgliteReady) return;
    const charge = await createCharge({
      callbackSecret: "must-not-be-returned",
      callbackChannel: {
        source: "dashboard",
        roomId: "10000000-0000-4000-8000-000000000010",
        agentId: "10000000-0000-4000-8000-000000000011",
      },
      callbackMetadata: { correlationId: "corr-five-dollar" },
    });

    expect(charge).toMatchObject({
      appId: APP_ID,
      amountUsd: 5,
      providers: ["stripe", "oxapay"],
      status: "requested",
    });
    expect(charge.paymentUrl).toContain(`/payment/app-charge/${APP_ID}/${charge.id}`);
    expect(charge.metadata).not.toHaveProperty("callback_secret");
    expect(charge.metadata.callback_secret_set).toBe(true);

    const row = await durableCharge(charge.id);
    expect(row).toMatchObject({
      organization_id: ORG_ID,
      user_id: USER_ID,
      expected_amount: "5.00",
      credits_to_add: "5.00",
      network: "APP_CHARGE",
      token: "USD",
      status: "requested",
    });
    expect(row.metadata).toMatchObject({
      kind: "app_charge_request",
      app_id: APP_ID,
      creator_user_id: USER_ID,
      creator_organization_id: ORG_ID,
      providers: ["stripe", "oxapay"],
      callback_channel: {
        roomId: "10000000-0000-4000-8000-000000000010",
        agentId: "10000000-0000-4000-8000-000000000011",
      },
      callback_metadata: { correlationId: "corr-five-dollar" },
    });
  });

  test("wrong amount, currency, and provider fail closed without mutating requested state", async () => {
    if (!pgliteReady) return;
    const charge = await createCharge({ providers: ["stripe"] });
    const base = {
      appId: APP_ID,
      chargeRequestId: charge.id,
      provider: "stripe" as const,
      providerPaymentId: "pi_exact_five",
      amountUsd: "5.00",
      currency: "USD",
      payerUserId: USER_ID,
      payerOrganizationId: ORG_ID,
    };

    await expectSettlementCode(
      settlement.markPaid({ ...base, amountUsd: "4.99" }),
      "APP_CHARGE_AMOUNT_MISMATCH",
    );
    await expectSettlementCode(
      settlement.markPaid({ ...base, currency: "EUR" }),
      "APP_CHARGE_CURRENCY_MISMATCH",
    );
    await expectSettlementCode(
      settlement.markPaid({ ...base, provider: "oxapay" }),
      "APP_CHARGE_PROVIDER_NOT_ALLOWED",
    );

    expect(await durableCharge(charge.id)).toMatchObject({
      status: "requested",
      received_amount: null,
      confirmed_at: null,
    });
  });

  test("expired charge rejects settlement and remains unpaid", async () => {
    if (!pgliteReady) return;
    const charge = await createCharge();
    await dbWrite
      .update(cryptoPayments)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(cryptoPayments.id, charge.id));

    await expectSettlementCode(
      settlement.markPaid({
        appId: APP_ID,
        chargeRequestId: charge.id,
        provider: "stripe",
        providerPaymentId: "pi_expired",
        amountUsd: "5.00",
        currency: "USD",
      }),
      "APP_CHARGE_EXPIRED",
    );
    expect(await durableCharge(charge.id)).toMatchObject({
      status: "requested",
      received_amount: null,
    });
  });

  test("exact settlement persists once; exact replay is inert and conflicting replay fails", async () => {
    if (!pgliteReady) return;
    const charge = await createCharge();
    const params = {
      appId: APP_ID,
      chargeRequestId: charge.id,
      provider: "stripe" as const,
      providerPaymentId: "pi_exact_replay",
      amountUsd: "5.00",
      currency: "usd",
      payerUserId: USER_ID,
      payerOrganizationId: ORG_ID,
      metadata: {
        stripe_checkout_session_id: "cs_exact_replay",
        paid_provider: "attacker-override",
      },
    };

    const first = await settlement.markPaid(params);
    expect(first.disposition).toBe("settled");
    expect(first.callback).toBeNull();

    const rowAfterFirst = await durableCharge(charge.id);
    expect(rowAfterFirst).toMatchObject({
      status: "confirmed",
      received_amount: "5.00",
      credits_to_add: "5.00",
    });
    expect(rowAfterFirst.metadata).toMatchObject({
      app_id: APP_ID,
      paid_provider: "stripe",
      paid_provider_payment_id: "pi_exact_replay",
      payer_user_id: USER_ID,
      payer_organization_id: ORG_ID,
      stripe_checkout_session_id: "cs_exact_replay",
    });
    expect(rowAfterFirst.confirmed_at).not.toBeNull();
    const queuedAfterFirst = await dbRead
      .select()
      .from(appChargeCallbackOutbox)
      .where(eq(appChargeCallbackOutbox.charge_request_id, charge.id));
    expect(queuedAfterFirst).toHaveLength(1);
    expect(queuedAfterFirst[0]).toMatchObject({ state: "pending", attempts: 0 });

    const replay = await settlement.markPaid(params);
    expect(replay).toEqual({ disposition: "replayed", callback: null });
    const rowAfterReplay = await durableCharge(charge.id);
    expect(rowAfterReplay.confirmed_at).toEqual(rowAfterFirst.confirmed_at);

    await expectSettlementCode(
      settlement.markPaid({
        ...params,
        providerPaymentId: "pi_conflicting_replay",
      }),
      "APP_CHARGE_SETTLEMENT_CONFLICT",
    );
    expect(await durableCharge(charge.id)).toMatchObject({
      status: "confirmed",
      received_amount: "5.00",
      metadata: expect.objectContaining({
        paid_provider_payment_id: "pi_exact_replay",
      }),
    });
  });
});
