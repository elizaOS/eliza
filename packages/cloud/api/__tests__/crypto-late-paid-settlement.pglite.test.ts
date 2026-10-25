/**
 * Drives the real OxaPay settlement paths against a PGlite database built from
 * the Drizzle schema. OxaPay decides whether a payment arrived inside its own
 * invoice lifetime; network confirmations can finish after that window, so a
 * "paid" invoice must still credit the organization even when the local
 * expires_at has passed or the cleanup cron already marked the row expired.
 */
import {
  afterAll,
  beforeAll,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
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
const { invoices } = await import("@elizaos/cloud-shared/db/schemas/invoices");
const { referralCodes, referralSignups } = await import(
  "@elizaos/cloud-shared/db/schemas/referrals"
);
const { cryptoPaymentsService } = await import(
  "@elizaos/cloud-shared/lib/services/crypto-payments"
);
const { oxaPayService } = await import(
  "@elizaos/cloud-shared/lib/services/oxapay"
);

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        creditTransactions,
        cryptoPayments,
        invoices,
        referralCodes,
        referralSignups,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function lapsedPayment() {
  const org = randomUUID();
  const user = randomUUID();
  const payment = randomUUID();
  const trackId = `track_${payment}`;
  const txHash = `0x${payment.replaceAll("-", "").padEnd(64, "0")}`;
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
    ) VALUES ($1,$2,$3,$4,'USDT','TRC20','50','50','pending',now() - interval '2 minutes',$5)`,
    [
      payment,
      org,
      user,
      trackId,
      JSON.stringify({
        oxapay_track_id: trackId,
        oxapay_order_id: `order_${trackId}`,
        fiat_currency: "USD",
        fiat_amount: "50",
      }),
    ],
  );
  spyOn(oxaPayService, "getPaymentStatus").mockResolvedValue({
    trackId,
    orderId: `order_${trackId}`,
    status: "paid",
    amount: "50",
    currency: "USD",
    transactions: [
      {
        txHash,
        amount: "50",
        currency: "USDT",
        nativeAmount: "50",
        usdAmount: "50",
      },
    ],
  } as Awaited<ReturnType<typeof oxaPayService.getPaymentStatus>>);
  return { org, payment, trackId, txHash };
}

async function settlement(org: string, payment: string) {
  const balance = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [org],
  );
  const row = await pg().query<{ status: string }>(
    "SELECT status FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return {
    balance: Number(balance.rows[0]?.credit_balance),
    status: row.rows[0]?.status,
  };
}

test("a paid webhook after the local expiry credits the organization", async () => {
  const { org, payment, trackId, txHash } = await lapsedPayment();

  await expect(
    cryptoPaymentsService.handleWebhook({
      track_id: trackId,
      status: "Paid",
      txID: txHash,
    }),
  ).resolves.toEqual({ success: true, message: "Payment confirmed" });

  expect(await settlement(org, payment)).toEqual({
    balance: 50,
    status: "confirmed",
  });
});

test("a paid webhook after the cleanup cron expired the row still credits", async () => {
  const { org, payment, trackId, txHash } = await lapsedPayment();
  for (const expired of await cryptoPaymentsService.listExpiredPendingPayments()) {
    await cryptoPaymentsService.expirePayment(expired);
  }
  expect((await settlement(org, payment)).status).toBe("expired");

  await expect(
    cryptoPaymentsService.handleWebhook({
      track_id: trackId,
      status: "Paid",
      txID: txHash,
    }),
  ).resolves.toEqual({ success: true, message: "Payment confirmed" });

  expect(await settlement(org, payment)).toEqual({
    balance: 50,
    status: "confirmed",
  });
});

test("status polling settles an expired row that OxaPay reports paid", async () => {
  const { org, payment } = await lapsedPayment();
  for (const expired of await cryptoPaymentsService.listExpiredPendingPayments()) {
    await cryptoPaymentsService.expirePayment(expired);
  }

  const result = await cryptoPaymentsService.checkAndConfirmPayment(payment);

  expect(result.confirmed).toBe(true);
  expect(await settlement(org, payment)).toEqual({
    balance: 50,
    status: "confirmed",
  });
});
