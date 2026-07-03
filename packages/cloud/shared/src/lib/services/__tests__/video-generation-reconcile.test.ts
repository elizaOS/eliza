/**
 * reconcilePendingVideoGenerations() — real PGlite-backed settlement proof
 * for the #11862 poll-timeout money path.
 *
 * The generate-video route keeps the credit hold open when the upstream job
 * outlives the poll window and persists a pending generation carrying the
 * settlement payload. These tests reserve REAL credits through
 * creditsService.reserve (the same atomic CTE the route uses), persist the
 * pending generation through the REAL repository, then run the REAL sweep and
 * assert balances, reservation settled_at, and refund rows straight from the
 * DB:
 *
 *  - timeout-then-success → the charge stands (no refund row, balance stays
 *    debited) and the generation completes with the delivered video;
 *  - timeout-then-failure → refunded exactly ONCE, idempotent across a
 *    crash-retry (row forced back to pending) and a concurrent double-poll;
 *  - deadline expiry → verified-non-terminal job refunds once;
 *  - probe failure → nothing moves (no blind refund, hold intact);
 *  - stranded-reservation sweep interplay → after the generic sweep settles
 *    the hold, the video sweep never mints a second movement.
 *
 * Only the upstream provider status probe is stubbed (registered through the
 * real registry API) — everything on the money path is real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const PGLITE_TIMEOUT = 60000;

const ORG_ID = "00000000-0000-0000-0000-0000000000f1";
const USER_ID = "00000000-0000-0000-0000-0000000000f2";
const START_BALANCE = 100;
const COST = 0.5;
const JOB_ID = "fal-req-42";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let creditsService: typeof import("../credits").creditsService;
let generationsRepository: typeof import("../../../db/repositories/generations").generationsRepository;
let reconcilePendingVideoGenerations: typeof import("../video-generation-reconcile").reconcilePendingVideoGenerations;
let registerVideoProvider: typeof import("../../providers/video/registry").registerVideoProvider;
let VIDEO_PENDING_SETTLEMENT_MARKER: typeof import("../../providers/video/types").VIDEO_PENDING_SETTLEMENT_MARKER;
type VideoJobStatus = import("../../providers/video/types").VideoJobStatus;
let pgliteReady = true;

/** Controllable upstream verdict for the stub provider. */
let jobStatusImpl: () => Promise<VideoJobStatus> = async () => ({ state: "pending" });
let jobStatusCalls = 0;

async function getBalance(): Promise<number> {
  const res = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG_ID}';`,
  );
  return Number((res.rows[0] as { credit_balance: string }).credit_balance);
}

async function seedOrg(): Promise<void> {
  await dbWrite.execute(`DELETE FROM generations WHERE organization_id = '${ORG_ID}';`);
  await dbWrite.execute(`DELETE FROM credit_transactions WHERE organization_id = '${ORG_ID}';`);
  await dbWrite.execute(`DELETE FROM organizations WHERE id = '${ORG_ID}';`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, credit_balance) VALUES ('${ORG_ID}', '${START_BALANCE}');`,
  );
}

async function getReservationSettledAt(id: string): Promise<string | null> {
  const res = await dbWrite.execute(
    `SELECT settled_at FROM credit_transactions WHERE id = '${id}';`,
  );
  return (res.rows[0] as { settled_at: string | null }).settled_at;
}

async function refundRowsForReservation(id: string): Promise<Array<{ amount: string }>> {
  const res = await dbWrite.execute(
    `SELECT amount FROM credit_transactions
     WHERE metadata->>'reservation_transaction_id' = '${id}'
       AND type = 'refund'
     ORDER BY created_at ASC;`,
  );
  return res.rows as Array<{ amount: string }>;
}

async function getGenerationRow(
  id: string,
): Promise<{ status: string; storage_url: string | null; error: string | null }> {
  const res = await dbWrite.execute(
    `SELECT status, storage_url, error FROM generations WHERE id = '${id}';`,
  );
  return res.rows[0] as { status: string; storage_url: string | null; error: string | null };
}

/**
 * Reserves real credits and persists the pending generation exactly the way
 * the route does after a VideoGenerationPendingError.
 */
async function createTimedOutGeneration(opts?: { ageMs?: number }): Promise<{
  generationId: string;
  reservationTransactionId: string;
}> {
  const reservation = await creditsService.reserve({
    organizationId: ORG_ID,
    userId: USER_ID,
    amount: COST,
    description: "Video generation: fal-ai/veo3",
  });
  if (!reservation.reservationTransactionId) {
    throw new Error("reserve() returned no reservation transaction id");
  }
  const generation = await generationsRepository.create({
    organization_id: ORG_ID,
    user_id: null,
    type: "video",
    model: "fal-ai/veo3",
    provider: "fal",
    prompt: "a lighthouse at dusk",
    status: "pending",
    metadata: {
      settlement_marker: VIDEO_PENDING_SETTLEMENT_MARKER,
      reservation_transaction_id: reservation.reservationTransactionId,
      reserved_amount: reservation.reservedAmount,
      billed_cost: COST,
      billing_source: "fal",
    },
    cost: String(COST),
    credits: String(COST),
    job_id: JOB_ID,
    created_at: new Date(Date.now() - (opts?.ageMs ?? 0)),
  });
  return {
    generationId: generation.id,
    reservationTransactionId: reservation.reservationTransactionId,
  };
}

function runSweep(opts?: { deadlineMs?: number }) {
  return reconcilePendingVideoGenerations({
    apiKeys: { FAL_KEY: "pglite-test-key" },
    deadlineMs: opts?.deadlineMs,
  });
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ creditsService } = await import("../credits"));
    ({ generationsRepository } = await import("../../../db/repositories/generations"));
    ({ reconcilePendingVideoGenerations } = await import("../video-generation-reconcile"));
    ({ registerVideoProvider } = await import("../../providers/video/registry"));
    ({ VIDEO_PENDING_SETTLEMENT_MARKER } = await import("../../providers/video/types"));

    // Same organizations/credit_transactions DDL as credits-reconcile.test.ts
    // (full org column set so the fire-and-forget post-mutation hooks that
    // SELECT every column don't blow up); generations mirrors the drizzle
    // schema columns the repository maps.
    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL DEFAULT 'test-org',
        slug text NOT NULL DEFAULT 'test-org',
        credit_balance numeric(20,6) NOT NULL DEFAULT '0' CHECK (credit_balance >= 0),
        settings jsonb DEFAULT '{}',
        stripe_customer_id text,
        billing_email text,
        stripe_payment_method_id text,
        stripe_default_payment_method text,
        auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(12,6),
        auto_top_up_amount numeric(12,6),
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
        steward_tenant_id text,
        steward_tenant_api_key text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        amount numeric(12,6) NOT NULL,
        type text NOT NULL,
        description text,
        metadata jsonb NOT NULL DEFAULT '{}',
        stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now(),
        settled_at timestamp
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
      `CREATE TABLE IF NOT EXISTS generations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        type text NOT NULL,
        model text NOT NULL,
        provider text NOT NULL,
        prompt text NOT NULL,
        prompt_storage text NOT NULL DEFAULT 'inline',
        prompt_key text,
        negative_prompt text,
        negative_prompt_storage text NOT NULL DEFAULT 'inline',
        negative_prompt_key text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        status text NOT NULL DEFAULT 'pending',
        error text,
        storage_url text,
        thumbnail_url text,
        content text,
        content_storage text NOT NULL DEFAULT 'inline',
        content_key text,
        file_size bigint,
        mime_type text,
        parameters jsonb,
        settings jsonb NOT NULL DEFAULT '{}',
        metadata jsonb NOT NULL DEFAULT '{}',
        dimensions jsonb,
        tokens integer,
        cost numeric(10,2) NOT NULL DEFAULT '0.00',
        credits numeric(10,2) NOT NULL DEFAULT '0.00',
        usage_record_id uuid,
        is_public boolean NOT NULL DEFAULT false,
        job_id text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now(),
        completed_at timestamp
      )`,
    ];
    for (const stmt of ddl) {
      await dbWrite.execute(stmt);
    }

    // Replace the real fal provider with a stub whose upstream verdict each
    // test controls. Registered through the real registry API — the sweep
    // resolves it exactly the way it resolves a production provider.
    registerVideoProvider({
      billingSource: "fal",
      generate: async () => {
        throw new Error("stub provider does not generate");
      },
      getJobStatus: async () => {
        jobStatusCalls++;
        return await jobStatusImpl();
      },
    });
  } catch (error) {
    pgliteReady = false;
    throw error;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  jobStatusImpl = async () => ({ state: "pending" });
  jobStatusCalls = 0;
  await seedOrg();
});

describe("timeout-then-success — charge on late success, never a refund", () => {
  test(
    "sweep settles the hold at the billed cost and completes the generation",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration();
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);

      jobStatusImpl = async () => ({
        state: "succeeded",
        result: {
          requestId: JOB_ID,
          video: { url: "https://fal.media/late.mp4", content_type: "video/mp4" },
        },
      });

      const stats = await runSweep();
      expect(stats).toMatchObject({ scanned: 1, charged: 1, refunded: 0, expired: 0 });

      // Charge stands: balance still debited, hold settled, zero refund rows.
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
      expect(await getReservationSettledAt(reservationTransactionId)).not.toBeNull();
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(0);

      const row = await getGenerationRow(generationId);
      expect(row.status).toBe("completed");
      expect(row.storage_url).toBe("https://fal.media/late.mp4");

      // Second tick: the row is terminal, nothing is scanned, money unmoved.
      const second = await runSweep();
      expect(second.scanned).toBe(0);
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
    },
    PGLITE_TIMEOUT,
  );
});

describe("timeout-then-failure — refund exactly once", () => {
  test(
    "verified upstream failure refunds the hold once, idempotent across a crash-retry",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration();
      jobStatusImpl = async () => ({ state: "failed", error: "render exploded" });

      const stats = await runSweep();
      expect(stats).toMatchObject({ scanned: 1, refunded: 1, charged: 0 });

      expect(await getBalance()).toBeCloseTo(START_BALANCE, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(1);
      const row = await getGenerationRow(generationId);
      expect(row.status).toBe("failed");
      expect(row.error).toBe("render exploded");

      // Crash between refund and row update: force the row back to pending
      // and sweep again — the settled_at claim must block a second refund.
      await dbWrite.execute(
        `UPDATE generations SET status = 'pending' WHERE id = '${generationId}';`,
      );
      await runSweep();
      expect(await getBalance()).toBeCloseTo(START_BALANCE, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(1);
      expect((await getGenerationRow(generationId)).status).toBe("failed");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "double-poll race: two concurrent sweeps produce exactly one refund",
    async () => {
      const { reservationTransactionId } = await createTimedOutGeneration();
      jobStatusImpl = async () => ({ state: "failed", error: "render exploded" });

      await Promise.all([runSweep(), runSweep()]);

      expect(await getBalance()).toBeCloseTo(START_BALANCE, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(1);
      expect(await getReservationSettledAt(reservationTransactionId)).not.toBeNull();
    },
    PGLITE_TIMEOUT,
  );

  test(
    "double-poll race on late success: concurrent sweeps never refund or double-settle",
    async () => {
      const { reservationTransactionId } = await createTimedOutGeneration();
      jobStatusImpl = async () => ({
        state: "succeeded",
        result: { requestId: JOB_ID, video: { url: "https://fal.media/late.mp4" } },
      });

      await Promise.all([runSweep(), runSweep()]);

      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(0);
      expect(await getReservationSettledAt(reservationTransactionId)).not.toBeNull();
    },
    PGLITE_TIMEOUT,
  );
});

describe("deadline + unknown-state behavior", () => {
  test(
    "verified-non-terminal job past the deadline refunds once and fails the row",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration({
        ageMs: 2 * 60 * 60 * 1000,
      });
      jobStatusImpl = async () => ({ state: "pending" });

      const stats = await runSweep();
      expect(stats).toMatchObject({ scanned: 1, expired: 1, refunded: 0, charged: 0 });
      expect(await getBalance()).toBeCloseTo(START_BALANCE, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(1);
      expect((await getGenerationRow(generationId)).status).toBe("failed");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "fresh pending job stays held (no refund, hold unsettled)",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration();
      jobStatusImpl = async () => ({ state: "pending" });

      const stats = await runSweep();
      expect(stats).toMatchObject({ scanned: 1, stillPending: 1, refunded: 0, charged: 0 });
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
      expect(await getReservationSettledAt(reservationTransactionId)).toBeNull();
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(0);
      expect((await getGenerationRow(generationId)).status).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );

  test(
    "status probe failure moves NOTHING — no blind refund, hold intact",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration({
        ageMs: 2 * 60 * 60 * 1000, // even past the deadline
      });
      jobStatusImpl = async () => {
        throw new Error("provider unreachable");
      };

      const stats = await runSweep();
      expect(stats).toMatchObject({ scanned: 1, skipped: 1, refunded: 0, expired: 0 });
      expect(jobStatusCalls).toBe(1);
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
      expect(await getReservationSettledAt(reservationTransactionId)).toBeNull();
      expect((await getGenerationRow(generationId)).status).toBe("pending");
    },
    PGLITE_TIMEOUT,
  );
});

describe("stranded-reservation sweep interplay — never mint", () => {
  test(
    "generic sweep settles first; the video sweep must not create a second movement",
    async () => {
      const { generationId, reservationTransactionId } = await createTimedOutGeneration();

      // The #11493 backstop fires (e.g. this cron was down for >2h): the hold
      // settles at the estimated cost.
      const sweepStats = await creditsService.sweepStaleReservations({ graceMs: 0 });
      expect(sweepStats.settled).toBeGreaterThanOrEqual(1);
      expect(await getReservationSettledAt(reservationTransactionId)).not.toBeNull();
      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);

      // Video sweep later verifies a terminal failure — the settled_at claim
      // blocks its refund: no second movement, no minted credit.
      jobStatusImpl = async () => ({ state: "failed", error: "render exploded" });
      await runSweep();

      expect(await getBalance()).toBeCloseTo(START_BALANCE - COST, 6);
      expect(await refundRowsForReservation(reservationTransactionId)).toHaveLength(0);
      expect((await getGenerationRow(generationId)).status).toBe("failed");
    },
    PGLITE_TIMEOUT,
  );
});
