/**
 * Real PGlite coverage for `AppChargeSettlementService.markPaid`.
 *
 * Create writes `requested`; some fixtures still seed `pending`. Both must
 * settle. Confirmed stays idempotent for the same provider payment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/common";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const CHARGE_ID = "00000000-0000-4000-8000-0000000000b2";
const APP_ID = "00000000-0000-4000-8000-0000000000b3";

const settlement = {
  appId: APP_ID,
  chargeRequestId: CHARGE_ID,
  provider: "stripe" as const,
  providerPaymentId: "pi_exact",
  amountUsd: "10.00",
  payerOrganizationId: ORG_ID,
};

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let settlementService: typeof import("../app-charge-settlement").appChargeSettlementService;

async function seedCharge(status: string): Promise<void> {
  await dbWrite.execute(`INSERT INTO crypto_payments
    (id, organization_id, payment_address, token, network, expected_amount, credits_to_add, status, expires_at, metadata)
    VALUES ('${CHARGE_ID}', '${ORG_ID}', 'charge', 'USD', 'internal', '10', '10', '${status}',
      now() + interval '1 hour', '{"kind":"app_charge_request","app_id":"${APP_ID}"}')`);
}

async function chargeStatus(): Promise<string> {
  const rows = await dbWrite.execute(`SELECT status FROM crypto_payments WHERE id='${CHARGE_ID}'`);
  return (rows.rows[0] as { status: string }).status;
}

async function callbackCount(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT count(*)::int AS count FROM app_charge_callback_outbox WHERE charge_request_id='${CHARGE_ID}'`,
  );
  return (rows.rows[0] as { count: number }).count;
}

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ appChargeSettlementService: settlementService } = await import("../app-charge-settlement"));
  await dbWrite.execute(`CREATE TABLE crypto_payments (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid,
    payment_address text NOT NULL, token_address text, token text NOT NULL, network text NOT NULL,
    expected_amount text NOT NULL, received_amount text, credits_to_add text NOT NULL,
    transaction_hash text, block_number text, status text NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
    confirmed_at timestamp, expires_at timestamp NOT NULL, metadata jsonb DEFAULT '{}'
  )`);
  await dbWrite.execute(`CREATE TABLE app_charge_callback_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_key text NOT NULL UNIQUE,
    charge_request_id uuid NOT NULL REFERENCES crypto_payments(id), payload jsonb NOT NULL,
    payload_digest text NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(), claim_token uuid, lease_expires_at timestamptz,
    last_error text, room_delivered_at timestamptz, http_delivered_at timestamptz,
    delivered_at timestamptz, terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`);
});

afterAll(async () => closeDb?.());

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM app_charge_callback_outbox");
  await dbWrite.execute("DELETE FROM crypto_payments");
});

describe("app charge settlement payable status", () => {
  test("marks a requested charge paid — the status create actually writes", async () => {
    await seedCharge("requested");
    await settlementService.markPaid(settlement);
    expect(await chargeStatus()).toBe("confirmed");
    expect(await callbackCount()).toBe(1);
  });

  test("still marks a pending fixture charge paid", async () => {
    await seedCharge("pending");
    await settlementService.markPaid(settlement);
    expect(await chargeStatus()).toBe("confirmed");
    expect(await callbackCount()).toBe(1);
  });

  test("confirmed replay with the same provider payment is idempotent", async () => {
    await seedCharge("requested");
    await settlementService.markPaid(settlement);
    await dbWrite.execute("DELETE FROM app_charge_callback_outbox");
    await settlementService.markPaid(settlement);
    expect(await chargeStatus()).toBe("confirmed");
    expect(await callbackCount()).toBe(1);
  });

  test("rejects a second provider payment after confirmation", async () => {
    await seedCharge("requested");
    await settlementService.markPaid(settlement);
    await expect(
      settlementService.markPaid({ ...settlement, providerPaymentId: "pi_other" }),
    ).rejects.toMatchObject({
      code: "APP_CHARGE_ALREADY_SETTLED",
    });
    expect(await chargeStatus()).toBe("confirmed");
  });

  test("rejects failed and expired rows instead of inventing a new status", async () => {
    for (const status of ["failed", "expired"]) {
      await dbWrite.execute("DELETE FROM app_charge_callback_outbox");
      await dbWrite.execute("DELETE FROM crypto_payments");
      await seedCharge(status);
      try {
        await settlementService.markPaid(settlement);
        throw new Error(`expected ${status} settlement to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(ElizaError);
        expect((error as ElizaError).code).toBe("INVALID_APP_CHARGE_STATUS");
      }
      expect(await chargeStatus()).toBe(status);
      expect(await callbackCount()).toBe(0);
    }
  });

  test("rejects a missing charge request", async () => {
    await expect(settlementService.markPaid(settlement)).rejects.toMatchObject({
      code: "APP_CHARGE_REQUEST_NOT_FOUND",
    });
  });

  test("rejects a non-positive settlement amount", async () => {
    await seedCharge("requested");
    await expect(
      settlementService.markPaid({ ...settlement, amountUsd: "0" }),
    ).rejects.toMatchObject({
      code: "INVALID_APP_CHARGE_SETTLEMENT_AMOUNT",
    });
    expect(await chargeStatus()).toBe("requested");
  });

  test("rejects a provider amount that differs from the charge authority", async () => {
    await seedCharge("requested");
    await expect(
      settlementService.markPaid({ ...settlement, amountUsd: "9.99" }),
    ).rejects.toMatchObject({
      code: "APP_CHARGE_REQUEST_MISMATCH",
    });
    expect(await chargeStatus()).toBe("requested");
    expect(await callbackCount()).toBe(0);
  });
});
