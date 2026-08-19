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
let settlementService: typeof import("../app-charge-settlement").appChargeSettlementService;

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ appChargeCallbacksService: service } = await import("../app-charge-callbacks"));
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
    const dispatcher = service as unknown as {
      dispatchSnapshot: () => Promise<{
        httpPosted: boolean;
        roomMessageCreated: boolean;
        errors: string[];
      }>;
    };
    const original = dispatcher.dispatchSnapshot.bind(service);
    let attempts = 0;
    dispatcher.dispatchSnapshot = async () => {
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
      dispatcher.dispatchSnapshot = original;
    }
  });

  test("a partial retry freezes its envelope and targets across charge metadata mutation", async () => {
    await dbWrite.transaction((tx) => service.enqueue(params, tx));
    type Snapshot = {
      envelope: { createdAt: string; charge: { amountUsd: string } };
      target: { callbackUrl?: string; channel?: Record<string, unknown> };
    };
    const dispatcher = service as unknown as {
      dispatchSnapshot: (
        snapshot: Snapshot,
        options?: { skipRoom?: boolean; skipHttp?: boolean },
      ) => Promise<{ httpPosted: boolean; roomMessageCreated: boolean; errors: string[] }>;
    };
    const original = dispatcher.dispatchSnapshot.bind(service);
    const optionsSeen: Array<{ skipRoom?: boolean; skipHttp?: boolean }> = [];
    const snapshotsSeen: Snapshot[] = [];
    dispatcher.dispatchSnapshot = async (snapshot, options = {}) => {
      snapshotsSeen.push(snapshot);
      optionsSeen.push(options);
      return optionsSeen.length === 1
        ? { httpPosted: false, roomMessageCreated: true, errors: ["HTTP unavailable"] }
        : { httpPosted: true, roomMessageCreated: false, errors: [] };
    };
    try {
      expect((await service.drain()).retried).toBe(1);
      await dbWrite.execute(`UPDATE crypto_payments SET expected_amount='999', metadata='{
          "kind":"app_charge_request",
          "app_id":"${params.appId}",
          "callback_url":"https://mutated.invalid/callback",
          "callback_channel":{"roomId":"mutated"}
        }'::jsonb WHERE id='${CHARGE_ID}'`);
      await dbWrite.execute(
        "UPDATE app_charge_callback_outbox SET next_attempt_at=now() - interval '1 second'",
      );
      expect((await service.drain()).delivered).toBe(1);
      expect(optionsSeen.map(({ skipRoom, skipHttp }) => ({ skipRoom, skipHttp }))).toEqual([
        { skipRoom: false, skipHttp: false },
        { skipRoom: true, skipHttp: false },
      ]);
      expect(snapshotsSeen[1]).toEqual(snapshotsSeen[0]);
      expect(snapshotsSeen[1]?.envelope.charge.amountUsd).toBe("10");
      expect(snapshotsSeen[1]?.target.callbackUrl).toBeUndefined();
      expect(snapshotsSeen[1]?.target.channel).toBeUndefined();
      const row = await dbWrite.execute(
        "SELECT room_delivered_at, http_delivered_at FROM app_charge_callback_outbox",
      );
      expect((row.rows[0] as { room_delivered_at: Date | null }).room_delivered_at).not.toBeNull();
      expect((row.rows[0] as { http_delivered_at: Date | null }).http_delivered_at).not.toBeNull();
    } finally {
      dispatcher.dispatchSnapshot = original;
    }
  });

  test("app charge status and callback intent commit together and replay recovers deletion", async () => {
    await dbWrite.execute(`UPDATE crypto_payments SET status='pending' WHERE id='${CHARGE_ID}'`);
    const settlement = {
      appId: params.appId,
      chargeRequestId: CHARGE_ID,
      provider: "stripe" as const,
      providerPaymentId: "pi_exact",
      amountUsd: "10.123456789",
      payerOrganizationId: ORG_ID,
    };

    await settlementService.markPaid(settlement);
    let rows = await dbWrite.execute(
      `SELECT payload, state FROM app_charge_callback_outbox WHERE charge_request_id='${CHARGE_ID}'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(
      (rows.rows[0] as { payload: { params: { amountUsd: string } } }).payload.params.amountUsd,
    ).toBe("10.123456789");

    await dbWrite.execute("DELETE FROM app_charge_callback_outbox");
    await settlementService.markPaid(settlement);
    rows = await dbWrite.execute(
      `SELECT payload FROM app_charge_callback_outbox WHERE charge_request_id='${CHARGE_ID}'`,
    );
    expect(rows.rows).toHaveLength(1);
    await expect(
      settlementService.markPaid({ ...settlement, providerPaymentId: "pi_other" }),
    ).rejects.toThrow("already settled by another payment");
  });

  test("failed charge status and notification intent commit atomically", async () => {
    await dbWrite.execute(`UPDATE crypto_payments SET status='pending' WHERE id='${CHARGE_ID}'`);
    const failed = { ...params, status: "failed" as const, reason: "provider declined" };

    expect(await service.failChargeAndEnqueue(failed)).toBe(true);
    const rows = await dbWrite.execute(`
      SELECT p.status, o.payload, o.state
      FROM crypto_payments p
      JOIN app_charge_callback_outbox o ON o.charge_request_id = p.id
      WHERE p.id='${CHARGE_ID}'
    `);
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { status: string }).status).toBe("failed");
    expect(
      (rows.rows[0] as { payload: { params: { status: string } } }).payload.params.status,
    ).toBe("failed");
    expect((rows.rows[0] as { state: string }).state).toBe("pending");

    await dbWrite.execute(`UPDATE crypto_payments SET status='confirmed' WHERE id='${CHARGE_ID}'`);
    expect(
      await service.failChargeAndEnqueue({ ...failed, providerPaymentId: "pi_late_failure" }),
    ).toBe(false);
    const late = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM app_charge_callback_outbox",
    );
    expect((late.rows[0] as { count: number }).count).toBe(1);
  });
});
