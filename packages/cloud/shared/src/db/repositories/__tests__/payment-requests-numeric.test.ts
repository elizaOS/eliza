/**
 * Exercises amount parsing and lifecycle compare-and-set behavior with deterministic fixtures.
 * Parser cases cover malformed driver values; repository cases use an isolated real PGlite database.
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
import { eq } from "drizzle-orm";
import { createPaymentRequestsService } from "../../../lib/services/payment-requests";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../schemas/apps";
import { organizations } from "../../schemas/organizations";
import { paymentRequestEvents, paymentRequests } from "../../schemas/payment-requests";
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

describe("PaymentRequestsRepository real PGlite wiring", () => {
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
        paymentRequestEvents,
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
    await dbWrite.delete(paymentRequestEvents);
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

  const createRequest = (organizationId: string, expiresAt: Date) =>
    repo.createPaymentRequest({
      organizationId,
      provider: "stripe",
      amountCents: 500,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
      expiresAt,
    });

  const eventsFor = (paymentRequestId: string) =>
    dbWrite
      .select()
      .from(paymentRequestEvents)
      .where(eq(paymentRequestEvents.payment_request_id, paymentRequestId));

  const transitionEventsFor = async (paymentRequestId: string) =>
    (await eventsFor(paymentRequestId)).filter((event) => event.event_name !== "payment.created");

  test("creates the request and its lifecycle event atomically", async () => {
    const created = await createRequest(await seedOrg(), new Date("2030-01-01T00:00:00Z"));

    expect((await eventsFor(created.id)).map((event) => event.event_name)).toEqual([
      "payment.created",
    ]);
  });

  test("duplicate settlement callbacks commit one transition and event", async () => {
    const created = await createRequest(await seedOrg(), new Date("2030-01-01T00:00:00Z"));
    const recordedAt = new Date("2029-12-31T23:59:59Z");

    const results = await Promise.all([
      repo.settlePaymentRequest(created.id, recordedAt, "pi-same", {}),
      repo.settlePaymentRequest(created.id, recordedAt, "pi-same", {}),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.getPaymentRequest(created.id))?.settlementTxRef).toBe("pi-same");
    expect((await transitionEventsFor(created.id)).map((event) => event.event_name)).toEqual([
      "payment.settled",
    ]);
  });

  test("settle and fail cannot commit mixed terminal state", async () => {
    const created = await createRequest(await seedOrg(), new Date("2030-01-01T00:00:00Z"));
    const recordedAt = new Date("2029-12-31T23:59:59Z");

    const results = await Promise.all([
      repo.settlePaymentRequest(created.id, recordedAt, "pi-race", { event: "synthetic" }),
      repo.failPaymentRequest(created.id, "synthetic failure", recordedAt),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = await repo.getPaymentRequest(created.id);
    const events = await transitionEventsFor(created.id);
    if (row?.status === "settled") {
      expect(row.settlementTxRef).toBe("pi-race");
      expect(events.map((event) => event.event_name)).toEqual(["payment.settled"]);
    } else {
      expect(row).toMatchObject({
        status: "failed",
        settledAt: null,
        settlementTxRef: null,
        settlementProof: null,
      });
      expect(events.map((event) => event.event_name)).toEqual(["payment.failed"]);
    }
  });

  test("settle and cancel commit one matching terminal event", async () => {
    const organizationId = await seedOrg();
    const created = await createRequest(organizationId, new Date("2030-01-01T00:00:00Z"));
    const recordedAt = new Date("2029-12-31T23:59:59Z");

    const results = await Promise.all([
      repo.settlePaymentRequest(created.id, recordedAt, "pi-cancel-race", {}),
      repo.cancelPaymentRequest(created.id, organizationId, "synthetic cancel", recordedAt),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = await repo.getPaymentRequest(created.id);
    const events = await transitionEventsFor(created.id);
    expect(row?.status === "settled" ? row.settlementTxRef : row?.status).toBe(
      row?.status === "settled" ? "pi-cancel-race" : "canceled",
    );
    expect(events.map((event) => event.event_name)).toEqual([
      row?.status === "settled" ? "payment.settled" : "payment.canceled",
    ]);
  });

  test("expiry wins at the exact deadline before checkout initialization", async () => {
    const deadline = new Date("2030-01-01T00:00:00Z");
    const created = await createRequest(await seedOrg(), deadline);

    const [initialized, expired] = await Promise.all([
      repo.initializePaymentRequest(
        created.id,
        { stripe_session_id: "cs_too_late" },
        "https://checkout.example.test/too-late",
        deadline,
      ),
      repo.expirePastPaymentRequest(created.id, deadline),
    ]);

    expect(initialized).toBeNull();
    expect(expired).toBe(true);
    expect(await repo.getPaymentRequest(created.id)).toMatchObject({
      status: "expired",
      hostedUrl: null,
      providerIntent: {},
    });
    expect((await transitionEventsFor(created.id)).map((event) => event.event_name)).toEqual([
      "payment.expired",
    ]);
  });

  test("keeps a delivered request settlement-eligible after its public deadline", async () => {
    const deadline = new Date("2030-01-01T00:00:00Z");
    const created = await createRequest(await seedOrg(), deadline);
    const delivered = await repo.initializePaymentRequest(
      created.id,
      { stripe_session_id: "cs_delivered" },
      "https://checkout.example.test/delivered",
      new Date("2029-12-31T23:59:59Z"),
    );

    expect(delivered?.status).toBe("delivered");
    expect(await repo.expirePastPaymentRequests(deadline)).toEqual([]);
    expect(
      await repo.settlePaymentRequest(
        created.id,
        new Date("2030-01-01T00:00:01Z"),
        "pi-after-deadline",
        {},
      ),
    ).toMatchObject({ status: "settled", settlementTxRef: "pi-after-deadline" });
    expect((await transitionEventsFor(created.id)).map((event) => event.event_name)).toEqual([
      "payment.delivered",
      "payment.settled",
    ]);
  });

  test("create cannot persist or return a provider URL after expiry wins", async () => {
    let releaseIntent: (() => void) | undefined;
    const intentBlocked = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    let requestCreated:
      | ((row: Awaited<ReturnType<typeof repo.createPaymentRequest>>) => void)
      | undefined;
    const createdRequest = new Promise<Awaited<ReturnType<typeof repo.createPaymentRequest>>>(
      (resolve) => {
        requestCreated = resolve;
      },
    );
    const service = createPaymentRequestsService({
      repository: repo,
      adapters: [
        {
          provider: "stripe",
          async createIntent({ request }) {
            requestCreated?.(request);
            await intentBlocked;
            return {
              hostedUrl: "https://checkout.example.test/orphan",
              providerIntent: { stripe_session_id: "cs_orphan" },
            };
          },
        },
      ],
    });

    const creating = service.create({
      organizationId: await seedOrg(),
      provider: "stripe",
      amountCents: 500,
      currency: "usd",
      paymentContext: { kind: "any_payer" },
    });
    const created = await createdRequest;
    expect(await repo.expirePastPaymentRequest(created.id, created.expiresAt)).toBe(true);
    releaseIntent?.();

    await expect(creating).rejects.toThrow('already in terminal status "expired"');
    expect(await repo.getPaymentRequest(created.id)).toMatchObject({
      status: "expired",
      hostedUrl: null,
      providerIntent: {},
    });
    expect((await eventsFor(created.id)).map((event) => event.event_name)).toEqual([
      "payment.created",
      "payment.expired",
    ]);
  });

  test("expiry sweep commits an event for each transitioned request", async () => {
    const organizationId = await seedOrg();
    const deadline = new Date("2030-01-01T00:00:00Z");
    const first = await createRequest(organizationId, deadline);
    const second = await createRequest(organizationId, deadline);

    expect((await repo.expirePastPaymentRequests(deadline)).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect((await transitionEventsFor(first.id)).map((event) => event.event_name)).toEqual([
      "payment.expired",
    ]);
    expect((await transitionEventsFor(second.id)).map((event) => event.event_name)).toEqual([
      "payment.expired",
    ]);
  });
});
