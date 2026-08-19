/** Exercises durable app-charge callback claim, retry, and replay semantics on real PGlite. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";
const CHARGE_ID = "00000000-0000-4000-8000-0000000000a2";
const params = {
  appId: "00000000-0000-4000-8000-0000000000a3",
  chargeRequestId: CHARGE_ID,
  status: "paid" as const,
  provider: "oxapay" as const,
  providerPaymentId: "00000000-0000-4000-8000-0000000000a4",
  amountUsd: "10.00",
  payerOrganizationId: ORG_ID,
};

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let service: typeof import("../app-charge-callbacks").appChargeCallbacksService;

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ appChargeCallbacksService: service } = await import("../app-charge-callbacks"));
  await dbWrite.execute(`CREATE TABLE crypto_payments (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid,
    payment_address text NOT NULL, token text NOT NULL, network text NOT NULL,
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
    last_error text, delivered_at timestamptz, terminal_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`);
});

afterAll(async () => closeDb?.());

beforeEach(async () => {
  await dbWrite.execute("DELETE FROM app_charge_callback_outbox");
  await dbWrite.execute("DELETE FROM crypto_payments");
  await dbWrite.execute(`INSERT INTO crypto_payments
    (id, organization_id, payment_address, token, network, expected_amount, credits_to_add, status, expires_at, metadata)
    VALUES ('${CHARGE_ID}', '${ORG_ID}', 'charge', 'USD', 'internal', '10', '10', 'confirmed',
      now() + interval '1 hour', '{"kind":"app_charge_request","app_id":"${params.appId}"}')`);
});

describe("app charge callback outbox", () => {
  test("enqueue replay validates the immutable payload", async () => {
    await dbWrite.transaction(async (tx) => {
      await service.enqueue(params, tx);
      await service.enqueue(params, tx);
      await expect(service.enqueue({ ...params, amountUsd: "11.00" }, tx)).rejects.toThrow(
        "does not match",
      );
    });
    const rows = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM app_charge_callback_outbox",
    );
    expect((rows.rows[0] as { count: number }).count).toBe(1);
  });

  test("failed delivery remains durable and the active dispatcher retries it", async () => {
    await dbWrite.transaction((tx) => service.enqueue(params, tx));
    const original = service.dispatch.bind(service);
    let attempts = 0;
    service.dispatch = async () => {
      attempts += 1;
      return attempts === 1
        ? { httpPosted: false, roomMessageCreated: false, errors: ["injected callback failure"] }
        : { httpPosted: true, roomMessageCreated: false, errors: [] };
    };
    try {
      const first = await service.drain();
      expect(first.retried).toBe(1);
      let row = await dbWrite.execute(
        "SELECT state, attempts, last_error FROM app_charge_callback_outbox",
      );
      expect((row.rows[0] as { state: string }).state).toBe("pending");
      expect((row.rows[0] as { last_error: string }).last_error).toContain("injected");

      await dbWrite.execute(
        "UPDATE app_charge_callback_outbox SET next_attempt_at=now() - interval '1 second'",
      );
      const second = await service.drain();
      expect(second.delivered).toBe(1);
      row = await dbWrite.execute("SELECT state, attempts FROM app_charge_callback_outbox");
      expect((row.rows[0] as { state: string; attempts: number }).state).toBe("delivered");
      expect(Number((row.rows[0] as { attempts: number }).attempts)).toBe(2);
    } finally {
      service.dispatch = original;
    }
  });
});
