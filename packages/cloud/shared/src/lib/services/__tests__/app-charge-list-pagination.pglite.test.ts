/** Exercises app-charge listing pagination against a real PGlite database. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000a1";
const APP_ID = "00000000-0000-4000-8000-0000000000a2";
const VALID_CHARGE_ID = "00000000-0000-4000-8000-0000000000a3";
const CORRUPT_CHARGE_ID = "00000000-0000-4000-8000-0000000000a4";
const OVERFLOW_CHARGE_ID = "00000000-0000-4000-8000-0000000000a5";

/** All-digit, long enough that `::numeric` raises 22003 if it is ever cast. */
const OVERFLOW_AMOUNT = "9".repeat(200_000);

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let appChargeRequestsService: typeof import("../app-charge-requests").appChargeRequestsService;

beforeAll(async () => {
  ({ dbWrite, closeDatabaseConnectionsForTests: closeDb } = await import("../../../db/client"));
  ({ appChargeRequestsService } = await import("../app-charge-requests"));

  await dbWrite.execute(`CREATE TABLE crypto_payments (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid,
    payment_address text NOT NULL, token_address text, token text NOT NULL, network text NOT NULL,
    expected_amount text NOT NULL, received_amount text, credits_to_add text NOT NULL,
    transaction_hash text, block_number text, status text NOT NULL,
    created_at timestamp NOT NULL, updated_at timestamp NOT NULL,
    confirmed_at timestamp, expires_at timestamp NOT NULL, metadata jsonb DEFAULT '{}'
  )`);

  await dbWrite.execute(`INSERT INTO crypto_payments
    (id, organization_id, payment_address, token, network, expected_amount, credits_to_add,
     status, created_at, updated_at, expires_at, metadata)
    VALUES
    ('${VALID_CHARGE_ID}', '${ORGANIZATION_ID}', 'valid', 'USD', 'APP_CHARGE', '25.00', '25.00',
     'requested', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z',
     '{"kind":"app_charge_request","app_id":"${APP_ID}"}'),
    ('${CORRUPT_CHARGE_ID}', '${ORGANIZATION_ID}', 'corrupt', 'USD', 'APP_CHARGE', 'NaN', '25.00',
     'requested', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2027-01-01T00:00:00Z',
     '{"kind":"app_charge_request","app_id":"${APP_ID}"}'),
    ('${OVERFLOW_CHARGE_ID}', '${ORGANIZATION_ID}', 'overflow', 'USD', 'APP_CHARGE', '${OVERFLOW_AMOUNT}', '25.00',
     'requested', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', '2027-01-01T00:00:00Z',
     '{"kind":"app_charge_request","app_id":"${APP_ID}"}')`);
}, 30_000);

afterAll(async () => closeDb?.(), 30_000);

describe("app charge request listing", () => {
  test("corrupt newest rows do not hide older valid rows at the requested limit", async () => {
    const charges = await appChargeRequestsService.listForApp(APP_ID, ORGANIZATION_ID, 1);

    expect(charges.map((charge) => charge.id)).toEqual([VALID_CHARGE_ID]);
  });

  test("a numeric-shaped value too long to cast is excluded, not raised as 22003", async () => {
    // The newest row is all digits, so a digit-shape-only pattern would match it
    // and force `::numeric`, which raises `value overflows numeric format`
    // before BETWEEN can reject it — failing the whole listing rather than
    // skipping one row. The length bound keeps it in the ELSE branch.
    const charges = await appChargeRequestsService.listForApp(APP_ID, ORGANIZATION_ID, 1);

    expect(charges.map((charge) => charge.id)).toEqual([VALID_CHARGE_ID]);
  });

  test("a readable row is still returned when the limit covers it", async () => {
    const charges = await appChargeRequestsService.listForApp(APP_ID, ORGANIZATION_ID, 100);

    expect(charges.map((charge) => charge.id)).toEqual([VALID_CHARGE_ID]);
  });
});
