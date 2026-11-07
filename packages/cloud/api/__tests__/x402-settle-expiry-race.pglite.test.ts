/**
 * Drives x402 payment-request settlement against a PGlite database built from
 * the Drizzle schema. Concurrent settles of one request must reach the
 * facilitator at most once, and a settle that reads a pending request just
 * before another settle confirms it must not flip the confirmed row back to
 * expired or emit an "expired" failure callback after the "paid" one.
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
const {
  apps,
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  userDatabaseStatusEnum,
  appEarnings,
  appEarningsTransactions,
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
} = await import("@elizaos/cloud-shared/db/schemas");
const safeFetchModule = await import(
  "@elizaos/cloud-shared/lib/security/safe-fetch"
);
const { cryptoPaymentsRepository } = await import(
  "@elizaos/cloud-shared/db/repositories/crypto-payments"
);
const { x402PaymentRequestsService } = await import(
  "@elizaos/cloud-shared/lib/services/x402-payment-requests"
);
const { x402FacilitatorService } = await import(
  "@elizaos/cloud-shared/lib/services/x402-facilitator"
);
const { redeemableEarningsService } = await import(
  "@elizaos/cloud-shared/lib/services/redeemable-earnings"
);

const pg = () => getPgliteClientForTests();

type Settlement = Awaited<ReturnType<typeof x402FacilitatorService.settle>>;

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        cryptoPayments,
        apps,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
        appEarnings,
        appEarningsTransactions,
        earningsSourceEnum,
        ledgerEntryTypeEnum,
        redeemableEarnings,
        redeemableEarningsLedger,
      },
      empty.id,
    ),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedRequest(status: "pending" | "confirmed", expiresAt: string) {
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
      ${expiresAt},$5,$6,$7)`,
    [
      payment,
      org,
      user,
      status,
      status === "confirmed" ? txHash : null,
      status === "confirmed" ? new Date() : null,
      JSON.stringify({
        kind: "x402_payment_request",
        amountUsd: 5,
        requirements: {
          scheme: "exact",
          network: "base",
          maxTimeoutSeconds: 300,
        },
      }),
    ],
  );
  return { payment, txHash };
}

const lapsedRequest = (status: "pending" | "confirmed") =>
  seedRequest(status, "now() - interval '1 second'");
const openRequest = () =>
  seedRequest("pending", "now() + interval '5 minutes'");

async function statusOf(payment: string) {
  const row = await pg().query<{ status: string }>(
    "SELECT status FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return row.rows[0]?.status;
}

async function settleClaim(payment: string) {
  const row = await pg().query<{ claim: string | null }>(
    "SELECT metadata->>'settleClaimedUntil' AS claim FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return row.rows[0]?.claim ?? null;
}

function failureCallbackSpy() {
  return spyOn(
    x402PaymentRequestsService as unknown as {
      triggerFailureCallback: (...args: unknown[]) => Promise<void>;
    },
    "triggerFailureCallback",
  );
}

function paymentPayload(signature: string) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "base",
      asset: "0x00000000000000000000000000000000000000bb",
      amount: "5000000",
      payTo: "0x00000000000000000000000000000000000000aa",
    },
    payload: { signature },
  };
}

function settledWith(transaction: string): Settlement {
  return {
    success: true,
    transaction,
    network: "base",
    payer: "0x00000000000000000000000000000000000000cc",
  } as Settlement;
}

const rejected = {
  success: false,
  errorReason: "invalid_signature",
  transaction: "",
  network: "base",
} as Settlement;

function stubEarnings() {
  spyOn(redeemableEarningsService, "addEarnings").mockResolvedValue({
    success: true,
  } as Awaited<ReturnType<typeof redeemableEarningsService.addEarnings>>);
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

test("a second authorization submitted while the first is settling never reaches the facilitator", async () => {
  const { payment, txHash } = await openRequest();
  let finish: (value: Settlement) => void = () => {};
  const facilitator = spyOn(x402FacilitatorService, "settle")
    .mockImplementationOnce(
      () =>
        new Promise<Settlement>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(rejected);
  stubEarnings();

  const first = x402PaymentRequestsService.settle(
    payment,
    paymentPayload("0x01"),
  );
  while (facilitator.mock.calls.length === 0) await Bun.sleep(1);

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x02")),
  ).rejects.toMatchObject({ status: 409, code: "settlement_in_progress" });
  expect(await statusOf(payment)).toBe("pending");

  finish(settledWith(txHash));
  const result = await first;

  expect(facilitator).toHaveBeenCalledTimes(1);
  expect(result.paymentRequest.paid).toBe(true);
  expect(await statusOf(payment)).toBe("confirmed");
  expect(await settleClaim(payment)).toBeNull();
});

test("a request that lapses mid-settlement is not expired under the in-flight settle", async () => {
  const { payment } = await openRequest();
  const failures = failureCallbackSpy();
  expect(
    await cryptoPaymentsRepository.claimSettlement(
      payment,
      new Date(Date.now() + 60_000),
    ),
  ).toBeDefined();
  await pg().query(
    "UPDATE crypto_payments SET expires_at = now() - interval '1 second' WHERE id=$1",
    [payment],
  );

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x02")),
  ).rejects.toMatchObject({ status: 409, code: "settlement_in_progress" });

  expect(await statusOf(payment)).toBe("pending");
  expect(failures).not.toHaveBeenCalled();
});

test("a facilitator rejection releases the claim so the payer can retry", async () => {
  const { payment, txHash } = await openRequest();
  const facilitator = spyOn(x402FacilitatorService, "settle")
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(settledWith(txHash));
  stubEarnings();

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x01")),
  ).rejects.toMatchObject({ status: 402 });
  expect(await settleClaim(payment)).toBeNull();

  const result = await x402PaymentRequestsService.settle(
    payment,
    paymentPayload("0x02"),
  );
  expect(result.paymentRequest.paid).toBe(true);
  expect(facilitator).toHaveBeenCalledTimes(2);
});

test("a facilitator error with an unknown outcome keeps the claim so a retry cannot pay twice", async () => {
  const { payment } = await openRequest();
  const facilitator = spyOn(x402FacilitatorService, "settle").mockRejectedValue(
    new Error("receipt timeout"),
  );

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x01")),
  ).rejects.toMatchObject({ status: 402 });
  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x02")),
  ).rejects.toMatchObject({ status: 409, code: "settlement_in_progress" });

  // A wall-clock deadline passing cannot authorize a second transfer.
  await pg().query(
    "UPDATE crypto_payments SET metadata = metadata || jsonb_build_object('settleClaimedUntil', '2000-01-01T00:00:00Z') WHERE id=$1",
    [payment],
  );
  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x03")),
  ).rejects.toMatchObject({ status: 409, code: "settlement_in_progress" });
  expect(await cryptoPaymentsRepository.markAsExpired(payment)).toBeUndefined();
  expect(facilitator).toHaveBeenCalledTimes(1);
  expect(await settleClaim(payment)).not.toBeNull();
});

async function seedAppRequest() {
  const { payment, txHash } = await openRequest();
  const owner = await pg().query<{ organization_id: string; user_id: string }>(
    "SELECT organization_id, user_id FROM crypto_payments WHERE id=$1",
    [payment],
  );
  const { organization_id: org, user_id: creator } = owner.rows[0] ?? {};
  const app = randomUUID();
  await pg().query(
    `INSERT INTO apps(id,name,slug,organization_id,created_by_user_id,app_url)
     VALUES ($1,'Seller app',$2,$3,$4,'https://seller.example')`,
    [app, `app-${app}`, org, creator],
  );
  await pg().query(
    `UPDATE crypto_payments
     SET metadata = metadata || jsonb_build_object('appId', $2::text, 'callbackUrl', 'https://seller.example/paid')
     WHERE id=$1`,
    [payment, app],
  );
  return { payment, txHash, app, creator: creator as string };
}

async function creatorBooks(app: string, creator: string) {
  const row = await pg().query<{
    redeemable: string | null;
    ledger: string;
    withdrawable: string | null;
    shadow: string;
    app_total: string | null;
  }>(
    `SELECT
       (SELECT total_earned FROM redeemable_earnings WHERE user_id=$2) AS redeemable,
       (SELECT count(*)::text FROM redeemable_earnings_ledger WHERE user_id=$2) AS ledger,
       (SELECT withdrawable_balance FROM app_earnings WHERE app_id=$1) AS withdrawable,
       (SELECT count(*)::text FROM app_earnings_transactions WHERE app_id=$1) AS shadow,
       (SELECT total_creator_earnings FROM apps WHERE id=$1) AS app_total`,
    [app, creator],
  );
  const books = row.rows[0];
  return {
    redeemable: Number(books?.redeemable ?? 0),
    ledger: Number(books?.ledger),
    withdrawable: Number(books?.withdrawable ?? 0),
    shadow: Number(books?.shadow),
    appTotal: Number(books?.app_total ?? 0),
  };
}

async function settlementPending(payment: string) {
  const row = await pg().query<{ pending: string | null }>(
    "SELECT metadata->>'settlementPending' AS pending FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return row.rows[0]?.pending ?? null;
}

function paidCallbacks(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return String(init?.body ?? "").includes("x402.payment_request.paid");
  }).length;
}

test("an app payment books creator earnings atomically and sends one paid callback", async () => {
  const { payment, txHash, app, creator } = await seedAppRequest();
  spyOn(x402FacilitatorService, "settle").mockResolvedValue(
    settledWith(txHash),
  );
  const fetches = spyOn(safeFetchModule, "safeFetch").mockResolvedValue(
    new Response("ok"),
  );

  await x402PaymentRequestsService.settle(payment, paymentPayload("0x01"));

  expect(await statusOf(payment)).toBe("confirmed");
  expect(await settlementPending(payment)).toBeNull();
  expect(await creatorBooks(app, creator)).toEqual({
    redeemable: 5,
    ledger: 1,
    withdrawable: 5,
    shadow: 1,
    appTotal: 5,
  });
  expect(paidCallbacks(fetches)).toBe(1);
});

test("earnings that fail after the on-chain transfer are completed once by the next settle", async () => {
  const { payment, txHash, app, creator } = await seedAppRequest();
  const facilitator = spyOn(x402FacilitatorService, "settle").mockResolvedValue(
    settledWith(txHash),
  );
  const fetches = spyOn(safeFetchModule, "safeFetch").mockResolvedValue(
    new Response("ok"),
  );
  await pg().query(
    "UPDATE apps SET total_platform_revenue = NULL WHERE id=$1",
    [app],
  );

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x01")),
  ).rejects.toThrow("Insufficient app aggregate balance");
  expect(await statusOf(payment)).toBe("confirmed");
  expect(await settlementPending(payment)).toBe("true");
  expect(paidCallbacks(fetches)).toBe(0);
  await pg().query("UPDATE apps SET total_platform_revenue = 0 WHERE id=$1", [
    app,
  ]);

  const retry = await x402PaymentRequestsService.settle(
    payment,
    paymentPayload("0x01"),
  );
  await x402PaymentRequestsService.settle(payment, paymentPayload("0x01"));

  expect(retry.paymentRequest.paid).toBe(true);
  expect(facilitator).toHaveBeenCalledTimes(1);
  expect(await settlementPending(payment)).toBeNull();
  expect(await creatorBooks(app, creator)).toEqual({
    redeemable: 5,
    ledger: 1,
    withdrawable: 5,
    shadow: 1,
    appTotal: 5,
  });
  expect(paidCallbacks(fetches)).toBe(1);
});

test("a request confirmed before settlement tracking is not re-credited on replay", async () => {
  const { payment } = await lapsedRequest("confirmed");
  const earnings = spyOn(redeemableEarningsService, "addEarnings");

  const result = await x402PaymentRequestsService.settle(payment, {});

  expect(result.paymentRequest.paid).toBe(true);
  expect(earnings).not.toHaveBeenCalled();
});

test("a redeemable write that fails after the on-chain transfer is credited by the next settle", async () => {
  const { payment, txHash, app, creator } = await seedAppRequest();
  spyOn(x402FacilitatorService, "settle").mockResolvedValue(
    settledWith(txHash),
  );
  const fetches = spyOn(safeFetchModule, "safeFetch").mockResolvedValue(
    new Response("ok"),
  );
  spyOn(redeemableEarningsService, "addEarnings").mockRejectedValueOnce(
    new Error("connection reset"),
  );

  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x01")),
  ).rejects.toThrow("connection reset");
  expect(await statusOf(payment)).toBe("confirmed");

  await x402PaymentRequestsService.settle(payment, paymentPayload("0x01"));

  expect(await creatorBooks(app, creator)).toEqual({
    redeemable: 5,
    ledger: 1,
    withdrawable: 5,
    shadow: 1,
    appTotal: 5,
  });
  expect(paidCallbacks(fetches)).toBe(1);
});

test("a rejected earnings result retains pending settlement for repair", async () => {
  const { payment, txHash, app, creator } = await seedAppRequest();
  const facilitator = spyOn(x402FacilitatorService, "settle").mockResolvedValue(
    settledWith(txHash),
  );
  const fetches = spyOn(safeFetchModule, "safeFetch").mockResolvedValue(
    new Response("ok"),
  );
  spyOn(redeemableEarningsService, "addEarnings").mockResolvedValueOnce({
    success: false,
    newBalance: 0,
    ledgerEntryId: "",
    error: "ledger unavailable",
  });
  await expect(
    x402PaymentRequestsService.settle(payment, paymentPayload("0x01")),
  ).rejects.toMatchObject({ code: "earnings_pending" });
  expect(await statusOf(payment)).toBe("confirmed");
  expect(await settlementPending(payment)).toBe("true");
  expect(paidCallbacks(fetches)).toBe(0);
  await x402PaymentRequestsService.settle(payment, {});
  expect(await creatorBooks(app, creator)).toEqual({
    redeemable: 5,
    ledger: 1,
    withdrawable: 5,
    shadow: 1,
    appTotal: 5,
  });
  expect(facilitator).toHaveBeenCalledTimes(1);
  expect(paidCallbacks(fetches)).toBe(1);
});
