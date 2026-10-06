/**
 * Drives x402 payment-request settlement against a PGlite database built from
 * the Drizzle schema. A settle that reads a pending request just before another
 * settle confirms it must not flip the confirmed row back to expired or emit an
 * "expired" failure callback after the "paid" one.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
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
const { cryptoPayments } = await import(
  "@elizaos/cloud-shared/db/schemas/crypto-payments"
);
const { cryptoPaymentsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/crypto-payments"
);
const { x402PaymentRequestsService } = await import(
  "@elizaos/cloud-shared/lib/services/x402-payment-requests"
);

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ organizations, users, cryptoPayments }, empty.id),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function lapsedRequest(status: "pending" | "confirmed") {
  const org = randomUUID();
  const user = randomUUID();
  const payment = randomUUID();
  const txHash = `0x${payment.replaceAll("-", "").padEnd(64, "0")}`;
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Seller',$2,'0')",
    [org, `seller-${org}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [user, org, `subject_${user}`],
  );
  await pg().query(
    `INSERT INTO crypto_payments(
      id,organization_id,user_id,payment_address,token,network,expected_amount,
      credits_to_add,status,expires_at,transaction_hash,confirmed_at,metadata
    ) VALUES ($1,$2,$3,'0x00000000000000000000000000000000000000aa','USDC','base','5','5',$4,
      now() - interval '1 second',$5,$6,$7)`,
    [
      payment,
      org,
      user,
      status,
      status === "confirmed" ? txHash : null,
      status === "confirmed" ? new Date() : null,
      JSON.stringify({ kind: "x402_payment_request", amountUsd: 5 }),
    ],
  );
  return { payment, txHash };
}

async function statusOf(payment: string) {
  const row = await pg().query<{ status: string }>(
    "SELECT status FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return row.rows[0]?.status;
}

function failureCallbackSpy() {
  return spyOn(
    x402PaymentRequestsService as unknown as {
      triggerFailureCallback: (...args: unknown[]) => Promise<void>;
    },
    "triggerFailureCallback",
  );
}

test("a settle that read a stale pending row keeps a concurrently confirmed request paid", async () => {
  const { payment, txHash } = await lapsedRequest("confirmed");
  const confirmed = await cryptoPaymentsRepository.findById(payment);
  if (!confirmed) throw new Error("seed row missing");
  spyOn(x402PaymentRequestsService, "get").mockResolvedValueOnce({
    ...confirmed,
    status: "pending",
    transaction_hash: null,
    confirmed_at: null,
  });
  const failures = failureCallbackSpy();

  const result = await x402PaymentRequestsService.settle(payment, {});

  expect(await statusOf(payment)).toBe("confirmed");
  expect(result.paymentRequest.paid).toBe(true);
  expect(
    JSON.parse(Buffer.from(result.paymentResponse, "base64").toString()),
  ).toMatchObject({ success: true, transaction: txHash, alreadySettled: true });
  expect(failures).not.toHaveBeenCalled();
});

test("a lapsed pending request still expires with a failure callback", async () => {
  const { payment } = await lapsedRequest("pending");
  const failures = failureCallbackSpy();

  await expect(
    x402PaymentRequestsService.settle(payment, {}),
  ).rejects.toMatchObject({
    status: 410,
  });

  expect(await statusOf(payment)).toBe("expired");
  expect(failures).toHaveBeenCalledTimes(1);
});

test("markAsExpired leaves non-pending rows untouched", async () => {
  const { payment } = await lapsedRequest("confirmed");

  expect(await cryptoPaymentsRepository.markAsExpired(payment)).toBeUndefined();
  expect(await statusOf(payment)).toBe("confirmed");
});
