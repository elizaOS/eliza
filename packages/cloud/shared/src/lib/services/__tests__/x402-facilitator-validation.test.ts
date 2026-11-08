/**
 * Malformed x402 payloads are refused before a payment request is claimed,
 * a verify that throws is a plain rejection, and a claim is released when no
 * transfer was sent. Also drives the x402_settlement_intents migration and
 * repository against PGlite.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } = await import(
  "../../../db/client"
);
const { organizations } = await import("../../../db/schemas/organizations");
const { users } = await import("../../../db/schemas/users");
const { cryptoPayments } = await import("../../../db/schemas/crypto-payments");
const { cryptoPaymentsRepository } = await import("../../../db/repositories/crypto-payments");
const { x402SettlementIntentsRepository } = await import(
  "../../../db/repositories/x402-settlement-intents"
);
const { malformedPaymentField, x402FacilitatorService } = await import("../x402-facilitator");
const { x402PaymentRequestsService } = await import("../x402-payment-requests");

const pg = () => {
  const client = getPgliteClientForTests();
  if (!client) throw new Error("PGlite test client was not initialized");
  return client;
};

const PAY_TO = "0x00000000000000000000000000000000000000aa";
const PAYER = "0x00000000000000000000000000000000000000cc";
const NONCE = `0x${"11".repeat(32)}`;

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson({ organizations, users, cryptoPayments }, empty.id),
  ))
    await pg().exec(statement.replaceAll('"public".', ""));
  const migration = readFileSync(
    new URL("../../../db/migrations/0558_x402_settlement_intents.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pg().exec(statement);
  }
});

afterEach(() => {
  mock.restore();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

function exactPayload(overrides: { amount?: string; value?: string; nonce?: string } = {}) {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "base",
      asset: "0x00000000000000000000000000000000000000bb",
      amount: overrides.amount ?? "5000000",
      payTo: PAY_TO,
    },
    payload: {
      signature: "0x01",
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: overrides.value ?? "5000000",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: overrides.nonce ?? NONCE,
      },
    },
  };
}

async function openRequest() {
  const org = randomUUID();
  const user = randomUUID();
  const payment = randomUUID();
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
      credits_to_add,status,expires_at,metadata
    ) VALUES ($1,$2,$3,$4,'USDC','base','5','5','pending',now() + interval '5 minutes',$5)`,
    [
      payment,
      org,
      user,
      PAY_TO,
      JSON.stringify({
        kind: "x402_payment_request",
        amountUsd: 5,
        requirements: { scheme: "exact", network: "base", maxTimeoutSeconds: 300 },
      }),
    ],
  );
  return payment;
}

async function settleClaim(payment: string) {
  const row = await pg().query<{ claim: string | null }>(
    "SELECT metadata->>'settleClaimedUntil' AS claim FROM crypto_payments WHERE id=$1",
    [payment],
  );
  return row.rows[0]?.claim ?? null;
}

describe("malformedPaymentField", () => {
  test("a well-formed exact payload passes", () => {
    expect(malformedPaymentField(exactPayload())).toBeUndefined();
  });

  test.each([
    ["accepted.amount", exactPayload({ amount: "five" })],
    ["accepted.amount", exactPayload({ amount: "1e6" })],
    ["authorization.value", exactPayload({ value: "-1" })],
    ["authorization.nonce", exactPayload({ nonce: "12" })],
  ])("names %s", (field, payload) => {
    expect(malformedPaymentField(payload)).toBe(field);
  });

  test("a permit fee that is not a number is named", () => {
    expect(
      malformedPaymentField({
        accepted: { amount: "1" },
        payload: {
          paymentPermit: {
            meta: { nonce: "7", validAfter: 0, validBefore: 100 },
            payment: { payAmount: "1" },
            fee: { feeAmount: "free" },
          },
        },
      }),
    ).toBe("paymentPermit.fee.feeAmount");
  });
});

describe("verify", () => {
  const requirements = {
    scheme: "exact",
    network: "base",
    asset: "0xbb",
    amount: "5",
    payTo: PAY_TO,
  };

  test("a malformed field is invalid, not a throw", async () => {
    expect(
      await x402FacilitatorService.verify(exactPayload({ amount: "x" }), requirements),
    ).toEqual({ isValid: false, invalidReason: "invalid_payment_payload" });
  });

  test("a throw inside verification is invalid, not a throw", async () => {
    spyOn(x402FacilitatorService, "initialize").mockRejectedValue(new Error("rpc down"));
    expect(await x402FacilitatorService.verify(exactPayload(), requirements)).toEqual({
      isValid: false,
      invalidReason: "verification_failed",
    });
  });
});

describe("payment request settle", () => {
  test("a non-numeric accepted.amount is a 400 that never claims the request", async () => {
    const payment = await openRequest();
    const settle = spyOn(x402FacilitatorService, "settle");

    await expect(
      x402PaymentRequestsService.settle(payment, exactPayload({ amount: "not-a-number" })),
    ).rejects.toMatchObject({ status: 400, code: "invalid_payment_payload" });

    expect(settle).not.toHaveBeenCalled();
    expect(await settleClaim(payment)).toBeNull();
  });

  test("a settle that throws before broadcasting releases the claim", async () => {
    const payment = await openRequest();
    spyOn(x402FacilitatorService, "settle").mockRejectedValue(new Error("signer unavailable"));

    await expect(x402PaymentRequestsService.settle(payment, exactPayload())).rejects.toMatchObject({
      status: 402,
      code: "settlement_failed",
    });

    expect(await settleClaim(payment)).toBeNull();
  });

  test("a settle that throws after broadcasting keeps the claim", async () => {
    const payment = await openRequest();
    spyOn(x402FacilitatorService, "settle").mockImplementation(async (_p, _r, options) => {
      await options?.onBroadcast?.({ transaction: `0x${"ab".repeat(32)}`, network: "base" });
      throw new Error("receipt read crashed");
    });

    await expect(x402PaymentRequestsService.settle(payment, exactPayload())).rejects.toMatchObject({
      status: 402,
    });

    expect(await settleClaim(payment)).not.toBeNull();
    expect((await cryptoPaymentsRepository.findById(payment))?.status).toBe("pending");
  });
});

describe("x402 settlement intents", () => {
  const identity = () => ({
    network: "eip155:8453",
    payer: PAYER,
    nonce: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
  });

  test("one row per payment identity, settled and credited once", async () => {
    const id = identity();
    const opened = await x402SettlementIntentsRepository.open({
      ...id,
      walletAddress: PAYER.toUpperCase().replace("0X", "0x"),
      amountUsd: 10,
    });
    const again = await x402SettlementIntentsRepository.open({
      ...id,
      payer: PAYER.toUpperCase().replace("0X", "0x"),
      walletAddress: PAY_TO,
      amountUsd: 50,
    });
    expect(again.id).toBe(opened.id);
    expect(again).toMatchObject({ status: "pending", wallet_address: PAYER, amount_usd: "10.00" });

    await x402SettlementIntentsRepository.recordBroadcast(opened.id, `0x${"cd".repeat(32)}`);
    const settled = await x402SettlementIntentsRepository.markSettled(opened.id, {
      transaction: `0x${"cd".repeat(32)}`,
      creditKey: "x402:eip155:8453:0xcd",
      sourceId: "wallet:10:0xcd",
    });
    expect(settled.status).toBe("settled");
    const later = new Date(Date.now() + 60_000);
    expect(
      (await x402SettlementIntentsRepository.listSettledBefore(later, 10)).map((row) => row.id),
    ).toContain(opened.id);

    const org = randomUUID();
    await x402SettlementIntentsRepository.markCredited(opened.id, org);
    expect(
      (await x402SettlementIntentsRepository.listSettledBefore(later, 10)).map((row) => row.id),
    ).not.toContain(opened.id);
    const reread = await x402SettlementIntentsRepository.markSettled(opened.id, {
      transaction: "0xother",
      creditKey: "other",
      sourceId: "other",
    });
    expect(reread).toMatchObject({
      status: "credited",
      organization_id: org,
      credit_key: "x402:eip155:8453:0xcd",
    });
  });

  test("a settled row without its credit key is refused by the table", async () => {
    const opened = await x402SettlementIntentsRepository.open({
      ...identity(),
      walletAddress: PAYER,
      amountUsd: 10,
    });
    await expect(
      pg().query("UPDATE x402_settlement_intents SET status='settled' WHERE id=$1", [opened.id]),
    ).rejects.toThrow();
  });
});
