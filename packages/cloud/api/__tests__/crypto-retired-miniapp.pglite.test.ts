/**
 * Drives the real OxaPay confirmation path against a PGlite database built
 * from the Drizzle schema. Mini-app charges were retired (#32021): a pending
 * OxaPay invoice created by that flow must never settle as a generic org
 * credit purchase. Confirmation fails closed with a typed error, leaving the
 * payment pending and the ledger untouched for operator reconciliation.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const { organizations } = await import(
  "@elizaos/cloud-shared/db/schemas/organizations"
);
const { users } = await import("@elizaos/cloud-shared/db/schemas/users");
const { creditTransactions } = await import(
  "@elizaos/cloud-shared/db/schemas/credit-transactions"
);
const { cryptoPayments } = await import(
  "@elizaos/cloud-shared/db/schemas/crypto-payments"
);
const { CryptoPaymentError, cryptoPaymentsService } = await import(
  "@elizaos/cloud-shared/lib/services/crypto-payments"
);

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      { organizations, users, creditTransactions, cryptoPayments },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function pendingPayment(metadata: Record<string, unknown>) {
  const org = randomUUID();
  const user = randomUUID();
  const payment = randomUUID();
  const trackId = `track_${payment}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Buyer',$2,'0')",
    [org, `buyer-${org}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  await pg().query(
    `INSERT INTO crypto_payments(
      id,organization_id,user_id,payment_address,token,network,expected_amount,
      credits_to_add,status,expires_at,metadata
    ) VALUES ($1,$2,$3,$4,'USDT','TRC20','5','5','pending',now() + interval '1 hour',$5)`,
    [
      payment,
      org,
      user,
      trackId,
      JSON.stringify({
        ...metadata,
        oxapay_track_id: trackId,
        fiat_currency: "USD",
        fiat_amount: "5",
      }),
    ],
  );
  return { org, payment, trackId };
}

const evidence = (trackId: string) => ({
  trackId,
  orderId: `order_${trackId}`,
  invoiceAmount: "5",
  invoiceCurrency: "USD",
  payCurrency: "USDT",
});

for (const [name, metadata] of [
  ["app_credit_purchase kind", { kind: "app_credit_purchase", app_id: "a" }],
  ["app_credit_purchase type", { type: "app_credit_purchase", app_id: "a" }],
  ["charge request link", { charge_request_id: randomUUID() }],
] as const) {
  test(`a retired mini-app OxaPay payment (${name}) fails closed without credit`, async () => {
    const { org, payment, trackId } = await pendingPayment(metadata);
    const attempt = cryptoPaymentsService.confirmPayment(
      payment,
      `tx_${payment}`,
      evidence(trackId),
    );
    await expect(attempt).rejects.toBeInstanceOf(CryptoPaymentError);
    await expect(attempt).rejects.toMatchObject({
      code: "RETIRED_MINIAPP_PAYMENT",
    });
    const status = await pg().query<{ status: string }>(
      "SELECT status FROM crypto_payments WHERE id=$1",
      [payment],
    );
    expect(status.rows[0]?.status).toBe("pending");
    const credits = await pg().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM credit_transactions WHERE organization_id=$1",
      [org],
    );
    expect(credits.rows[0]?.count).toBe(0);
  });
}
