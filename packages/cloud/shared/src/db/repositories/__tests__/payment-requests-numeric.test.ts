/**
 * Fail-closed money boundary for `payment_requests.amount_cents` reads
 * (#13416, cloud-shared DB-repository fallback-slop sweep).
 *
 * `amount_cents` is a NOT NULL `bigint` column. Before this slice `toDomain`
 * read it with a bare `Number(row.amount_cents)`, which fails open two ways and
 * flows straight into the Stripe adapter:
 *
 *   - `Number(veryLargeBigInt)` loses precision above `2^53 - 1`, so the
 *     `unit_amount: request.amountCents` sent to Stripe no longer equals the
 *     authorized amount — a mischarge with no error.
 *   - `Number(<malformed string from a raw-query/driver path>)` is `NaN`, and
 *     the adapter's reject guard `if (request.amountCents <= 0)` evaluates
 *     `NaN <= 0` as `false`, so a request with no readable amount slips past the
 *     zero/negative check and a checkout session is created for `NaN`.
 *
 * The parser suite pins the boundary exhaustively (deterministic, no DB). The
 * PGlite wiring test proves `getPaymentRequest` round-trips a real stored amount
 * (incl. a large-but-safe value) through the parser without precision loss and
 * returns `null` — not a fabricated row — for a genuinely-missing id. A corrupt
 * bigint cannot be *stored* in Postgres/PGlite, so the corrupt/oversized
 * fail-closed behavior is proven at the parser boundary the method calls (the
 * regression cases below), which is exactly the read-time driver-quirk /
 * raw-query failure mode this guards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// PGlite isolation harness (mirrors agent-billing-numeric.test.ts): the wiring
// suite fails LOUDLY against a shared non-PGlite Postgres.
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { organizations } from "../../schemas/organizations";
import { paymentRequests } from "../../schemas/payment-requests";
import { users } from "../../schemas/users";
import { PaymentRequestsRepository } from "../payment-requests";
import { parsePaymentAmountCents } from "../payment-requests-numeric";

describe("parsePaymentAmountCents", () => {
  test("parses a bigint amount losslessly within safe range", () => {
    expect(parsePaymentAmountCents(0n, "amount_cents")).toBe(0);
    expect(parsePaymentAmountCents(2500n, "amount_cents")).toBe(2500);
    expect(parsePaymentAmountCents(BigInt(Number.MAX_SAFE_INTEGER), "amount_cents")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test("parses a numeric literal and a well-formed string", () => {
    expect(parsePaymentAmountCents(1999, "amount_cents")).toBe(1999);
    expect(parsePaymentAmountCents("1999", "amount_cents")).toBe(1999);
  });

  test("allows an explicit domain zero (a free/zero-amount request)", () => {
    expect(parsePaymentAmountCents(0n, "amount_cents")).toBe(0);
    expect(parsePaymentAmountCents("0", "amount_cents")).toBe(0);
  });

  test("throws on fractional cents instead of materializing a corrupt money value", () => {
    expect(() => parsePaymentAmountCents(12.3, "amount_cents")).toThrow(/not an integer/);
    expect(() => parsePaymentAmountCents("12.3", "amount_cents")).toThrow(/not an integer/);
    expect(() => parsePaymentAmountCents("-5.5", "amount_cents")).toThrow(/not an integer/);
  });

  test("throws on negative cents; zero is the only non-positive domain value", () => {
    expect(() => parsePaymentAmountCents(-1n, "amount_cents")).toThrow(/negative/);
    expect(() => parsePaymentAmountCents(-1, "amount_cents")).toThrow(/negative/);
    expect(() => parsePaymentAmountCents("-1", "amount_cents")).toThrow(/negative/);
  });

  test("throws on null / undefined instead of fabricating 0", () => {
    expect(() => parsePaymentAmountCents(null, "amount_cents")).toThrow(/amount_cents/);
    expect(() => parsePaymentAmountCents(undefined, "amount_cents")).toThrow(/empty or missing/);
  });

  test("throws on empty / whitespace string instead of fabricating 0", () => {
    expect(() => parsePaymentAmountCents("", "amount_cents")).toThrow(/empty or missing/);
    expect(() => parsePaymentAmountCents("   ", "amount_cents")).toThrow(/empty or missing/);
  });

  test("REGRESSION: a bigint beyond safe-integer range throws instead of losing precision", () => {
    // Number(unsafeBigInt) silently rounds — the charged unit_amount would
    // diverge from the authorized amount. Prove the raw narrowing is lossy,
    // then prove the boundary refuses it.
    const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(BigInt(Number(unsafe))).not.toBe(unsafe); // lossy round-trip
    expect(() => parsePaymentAmountCents(unsafe, "amount_cents")).toThrow(
      /exceeds safe integer range/,
    );
    expect(() => parsePaymentAmountCents(-unsafe, "amount_cents")).toThrow(
      /exceeds safe integer range/,
    );
  });

  test("REGRESSION: a malformed string throws instead of becoming NaN (adapter fail-open guard)", () => {
    // This is the exact class the read used to swallow: `Number("corrupt")` is
    // NaN, and the Stripe adapter's `if (request.amountCents <= 0)` reject
    // evaluates `NaN <= 0` as false — the zero/negative guard is bypassed.
    expect(Number("corrupt")).toBeNaN();
    expect(Number("corrupt") <= 0).toBe(false);
    expect(() => parsePaymentAmountCents("corrupt", "amount_cents")).toThrow(/not a finite number/);
    expect(() => parsePaymentAmountCents("12.3.4", "amount_cents")).toThrow(/not a finite number/);
    expect(() => parsePaymentAmountCents("NaN", "amount_cents")).toThrow(/not a finite number/);
    expect(() => parsePaymentAmountCents("Infinity", "amount_cents")).toThrow(
      /not a finite number/,
    );
  });

  test("honors a caller-supplied field name in the error", () => {
    expect(() => parsePaymentAmountCents(null, "amount_cents")).toThrow(/amount_cents/);
  });
});

describe("PaymentRequestsRepository.getPaymentRequest fail-closed wiring", () => {
  const PGLITE_TIMEOUT = 60_000;
  const repo = new PaymentRequestsRepository();
  let pgliteReady = true;

  let seq = 0;
  const uniq = (prefix: string): string => {
    seq += 1;
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[payment-requests-numeric.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite wiring suite fails — pushSchema against a shared connection crashes the bun runner and would mutate the shared schema. Parser suite above still runs.",
      );
      return;
    }
    try {
      const schema = {
        organizations,
        users,
        apps,
        paymentRequests,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
      };
      const { apply } = await pushSchema(schema as never, dbWrite as never);
      await apply();
    } catch (error) {
      pgliteReady = false;
      console.error(
        "[payment-requests-numeric.test] PGlite/pushSchema unavailable — cannot drive PaymentRequestsRepository against a real DB. Skipping wiring cases.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(paymentRequests);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  const seedOrg = async (): Promise<string> => {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Pay Org", slug: uniq("org") })
      .returning();
    return org.id;
  };

  test("a real amount_cents read routes through the parser (healthy path)", async () => {
    expect(pgliteReady).toBe(true);
    const orgId = await seedOrg();
    const created = await repo.createPaymentRequest({
      organizationId: orgId,
      provider: "stripe",
      amountCents: 2599,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const fetched = await repo.getPaymentRequest(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.amountCents).toBe(2599);
    expect(Number.isFinite(fetched?.amountCents as number)).toBe(true);
  });

  test("a large-but-safe amount round-trips without precision loss", async () => {
    expect(pgliteReady).toBe(true);
    const orgId = await seedOrg();
    // 9,999,999,999,99 cents (~$100B) — well within safe-integer range but far
    // larger than a typical charge; proves the bigint read stays exact.
    const bigAmount = 999_999_999_999;
    const created = await repo.createPaymentRequest({
      organizationId: orgId,
      provider: "stripe",
      amountCents: bigAmount,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const fetched = await repo.getPaymentRequest(created.id);
    expect(fetched?.amountCents).toBe(bigAmount);
  });

  test("a genuinely-missing request returns null — NOT a fabricated row", async () => {
    expect(pgliteReady).toBe(true);
    const fetched = await repo.getPaymentRequest("00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeNull();
  });

  test("an explicit zero amount reads as 0 (distinguishable from a missing row's null)", async () => {
    expect(pgliteReady).toBe(true);
    const orgId = await seedOrg();
    const created = await repo.createPaymentRequest({
      organizationId: orgId,
      provider: "wallet_native",
      amountCents: 0,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const fetched = await repo.getPaymentRequest(created.id);
    expect(fetched?.amountCents).toBe(0);
  });
});
