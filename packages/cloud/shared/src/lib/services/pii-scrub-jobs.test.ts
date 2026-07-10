/**
 * Real-DB (PGlite) lifecycle coverage for the CLOUD-lane PII scrub job rails
 * (#14808): enqueue → claim → execute → resume → complete against the real
 * `jobs` + `pii_scrub_markers` tables, driven through the REAL
 * `jobsRepository` / `piiScrubMarkersRepository` and the REAL tier-0 executor
 * (core's `detectPii` + the seam's fail-closed validator). Nothing between the
 * service and the database is mocked.
 *
 * Covers the acceptance items this slice owns:
 *  - crash-resume with zero cursor state (kill mid-batch → re-claim → only
 *    unmarked items re-run; zero duplicate markers);
 *  - bounded retry semantics (real failures burn attempts; malformed payloads
 *    fail PERMANENTLY without retry churn; drain-budget stops requeue without
 *    burning an attempt — the #15737 lesson);
 *  - fail-closed / never-fabricate on the rails (residue with no escalation
 *    handler quarantines the item: no marker, loud failure);
 *  - tenant isolation (one org's markers never skip another org's work; jobs
 *    are invisible cross-org);
 *  - two-worker claim → exactly-once (FOR UPDATE SKIP LOCKED) and the
 *    marker-level tryCreate race;
 *  - marker-key lockstep with the LOCAL lane's content-addressed key shape.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const PGLITE_TIMEOUT = 120_000;

const ORG_A = "00000000-0000-4000-8000-00000000148a";
const ORG_B = "00000000-0000-4000-8000-00000000148b";
const USER = "00000000-0000-4000-8000-00000000148c";
const RULESET = "2026.07";

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests | undefined;
let jobsRepo: typeof import("../../db/repositories/jobs").jobsRepository;
let markersRepo: typeof import("../../db/repositories/pii-scrub-markers").piiScrubMarkersRepository;
let markerKeyForContent: typeof import("../../db/repositories/pii-scrub-markers").piiScrubMarkerKeyForContent;
let svc: typeof import("./pii-scrub-jobs");
let makeExecutor: typeof import("./pii-scrub-executor").createPiiScrubItemExecutor;
let pgliteReady = true;

type ItemExecutor = import("./pii-scrub-executor").PiiScrubItemExecutor;

/** Wrap the REAL tier-0 executor, recording every itemRef it actually runs. */
function countingExecutor(): { executor: ItemExecutor; calls: string[] } {
  const real = makeExecutor();
  const calls: string[] = [];
  return {
    calls,
    executor: {
      async scrubItem(input) {
        calls.push(input.itemRef);
        return real.scrubItem(input);
      },
    },
  };
}

/** An executor that fails for the given itemRefs and tier-0-completes the rest. */
function failingExecutor(failRefs: Set<string>): { executor: ItemExecutor; calls: string[] } {
  const real = makeExecutor();
  const calls: string[] = [];
  return {
    calls,
    executor: {
      async scrubItem(input) {
        calls.push(input.itemRef);
        if (failRefs.has(input.itemRef)) {
          throw new Error(`injected transient failure for ${input.itemRef}`);
        }
        return real.scrubItem(input);
      },
    },
  };
}

function items(
  refs: string[],
  contentFor: (ref: string) => string = (r) => `note ${r}: plain text`,
) {
  return refs.map((itemRef) => ({ itemRef, content: contentFor(itemRef) }));
}

async function jobRow(id: string) {
  const rows = await dbWrite.execute(
    `SELECT id, status, attempts, error, result FROM jobs WHERE id = '${id}';`,
  );
  return (rows as { rows: Array<Record<string, unknown>> }).rows[0];
}

/** Clear retry backoff so the next drain tick can re-claim immediately. */
async function clearBackoff(jobId: string) {
  await dbWrite.execute(
    `UPDATE jobs SET scheduled_for = NOW() - INTERVAL '1 minute' WHERE id = '${jobId}';`,
  );
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../db/client"));
    ({ jobsRepository: jobsRepo } = await import("../../db/repositories/jobs"));
    ({ piiScrubMarkersRepository: markersRepo, piiScrubMarkerKeyForContent: markerKeyForContent } =
      await import("../../db/repositories/pii-scrub-markers"));
    svc = await import("./pii-scrub-jobs");
    ({ createPiiScrubItemExecutor: makeExecutor } = await import("./pii-scrub-executor"));

    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        data jsonb NOT NULL,
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        agent_id text,
        character_id text,
        result jsonb,
        result_storage text NOT NULL DEFAULT 'inline',
        result_key text,
        error text,
        error_storage text NOT NULL DEFAULT 'inline',
        error_key text,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        organization_id uuid NOT NULL,
        user_id uuid,
        api_key_id uuid,
        generation_id uuid,
        webhook_url text,
        webhook_status text,
        estimated_completion_at timestamp,
        scheduled_for timestamp NOT NULL DEFAULT now(),
        started_at timestamp,
        completed_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      );`,
    );
    await dbWrite.execute(
      `CREATE TABLE IF NOT EXISTS pii_scrub_markers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        organization_id uuid NOT NULL,
        marker_key text NOT NULL,
        content_hash text NOT NULL,
        ruleset_version text NOT NULL,
        model_id text NOT NULL,
        tier0_only boolean NOT NULL,
        job_id uuid,
        created_at timestamp DEFAULT now() NOT NULL
      );`,
    );
    await dbWrite.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS pii_scrub_markers_org_key_idx
        ON pii_scrub_markers (organization_id, marker_key);`,
    );
  } catch (error) {
    pgliteReady = false;
    console.warn("[pii-scrub-jobs] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.execute("DELETE FROM jobs;");
  await dbWrite.execute("DELETE FROM pii_scrub_markers;");
});

// ---------------------------------------------------------------------------
// Marker-key lockstep with the LOCAL lane
// ---------------------------------------------------------------------------

describe("marker key — shared content-addressed shape", () => {
  test("cloud builder emits pii:<sha256(content)>:v<ruleset> exactly", () => {
    const content = "Contact jane.doe@example.com about invoice 42.";
    const expectedHash = createHash("sha256").update(content).digest("hex");
    expect(markerKeyForContent(content, RULESET)).toBe(`pii:${expectedHash}:v${RULESET}`);
  });

  test("empty ruleset version is refused (never a version-collapsed namespace)", () => {
    expect(() => markerKeyForContent("some content", "")).toThrow(/rulesetVersion/);
  });
});

// ---------------------------------------------------------------------------
// Enqueue validation (the 202 front door)
// ---------------------------------------------------------------------------

describe("enqueuePiiScrubBatch — validation", () => {
  test("rejects a non-UUID org, empty items, duplicate refs, oversize batches", async () => {
    const base = {
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
    };
    await expect(
      svc.enqueuePiiScrubBatch({ ...base, organizationId: "not-a-uuid", items: items(["a"]) }),
    ).rejects.toThrow(svc.PiiScrubJobDataError);
    await expect(svc.enqueuePiiScrubBatch({ ...base, items: [] })).rejects.toThrow(
      svc.PiiScrubJobDataError,
    );
    await expect(
      svc.enqueuePiiScrubBatch({ ...base, items: items(["dup", "dup"]) }),
    ).rejects.toThrow(/duplicate itemRef/);
    await expect(
      svc.enqueuePiiScrubBatch({
        ...base,
        items: items(
          Array.from({ length: svc.PII_SCRUB_MAX_ITEMS_PER_JOB + 1 }, (_, i) => `i${i}`),
        ),
      }),
    ).rejects.toThrow(/batch ceiling/);
    await expect(
      svc.enqueuePiiScrubBatch({ ...base, rulesetVersion: "", items: items(["a"]) }),
    ).rejects.toThrow(/rulesetVersion/);
  });

  test("creates a durable pending row owned by the org", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      stage: "llm-pass",
      items: items(["m-1", "m-2"]),
    });
    expect(job.type).toBe(svc.PII_SCRUB_JOB_TYPE);
    expect(job.status).toBe("pending");
    expect(job.organization_id).toBe(ORG_A);
    const fetched = await svc.getPiiScrubJobForOrg(job.id, ORG_A);
    expect(fetched?.id).toBe(job.id);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle: enqueue → claim → execute → complete
// ---------------------------------------------------------------------------

describe("processPendingPiiScrubJobs — lifecycle", () => {
  test("drains a batch through the real tier-0 executor and writes one marker per item", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["n-1", "n-2", "n-3"], (r) => `note ${r}: reach me at ${r}@example.com`),
    });

    const { executor, calls } = countingExecutor();
    const stats = await svc.processPendingPiiScrubJobs({ executor });

    expect(stats.claimed).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(0);
    expect(calls.sort()).toEqual(["n-1", "n-2", "n-3"]);

    const row = await jobRow(job.id);
    expect(row?.status).toBe("completed");
    const progress = row?.result as Record<string, unknown>;
    expect(progress).toMatchObject({
      itemsTotal: 3,
      itemsCompleted: 3,
      itemsSkipped: 0,
      itemsFailed: 0,
    });

    // Done-marker table dump: one tenant-scoped, content-addressed row per item.
    const markers = await markersRepo.listByJob(ORG_A, job.id);
    expect(markers).toHaveLength(3);
    for (const marker of markers) {
      expect(marker.organization_id).toBe(ORG_A);
      expect(marker.marker_key).toBe(`pii:${marker.content_hash}:v${RULESET}`);
      expect(marker.model_id).toBe("tier0");
      expect(marker.tier0_only).toBe(true);
      expect(marker.job_id).toBe(job.id);
    }
  });

  test("re-enqueueing already-scrubbed content completes with zero executor calls", async () => {
    const batch = items(["r-1", "r-2"]);
    const first = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: batch,
    });
    await svc.processPendingPiiScrubJobs({ executor: makeExecutor() });
    expect((await jobRow(first.id))?.status).toBe("completed");

    const second = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: batch,
    });
    const { executor, calls } = countingExecutor();
    const stats = await svc.processPendingPiiScrubJobs({ executor });

    expect(stats.succeeded).toBe(1);
    expect(calls).toEqual([]); // every item skipped via its marker
    const row = await jobRow(second.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ itemsSkipped: 2, itemsCompleted: 0 });
  });
});

// ---------------------------------------------------------------------------
// Crash-resume: kill mid-batch, re-claim, zero duplicated work
// ---------------------------------------------------------------------------

describe("processPendingPiiScrubJobs — crash-resume with zero cursor state", () => {
  test("a worker killed mid-batch resumes from markers: only unfinished items re-run", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["c-1", "c-2", "c-3", "c-4"]),
    });

    // Simulate the dead worker: it CLAIMED the job (pending → in_progress),
    // durably finished items c-1 and c-2 (their markers committed), then was
    // kill -9'd before touching c-3/c-4 or the job row again.
    const claimed = await jobsRepo.claimPendingJobs({ type: svc.PII_SCRUB_JOB_TYPE, limit: 1 });
    expect(claimed).toHaveLength(1);
    for (const ref of ["c-1", "c-2"]) {
      const content = `note ${ref}: plain text`;
      const key = markerKeyForContent(content, RULESET);
      const created = await markersRepo.tryCreate({
        organization_id: ORG_A,
        marker_key: key,
        content_hash: key.split(":")[1],
        ruleset_version: RULESET,
        model_id: "tier0",
        tier0_only: true,
        job_id: job.id,
      });
      expect(created.created).toBe(true);
    }
    // The crash left the row in_progress with a stale started_at.
    await dbWrite.execute(
      `UPDATE jobs SET started_at = NOW() - INTERVAL '10 minutes' WHERE id = '${job.id}';`,
    );

    // Tick 1: nothing claimable yet (the row is in_progress), but the built-in
    // stale sweep re-arms it — the crashed-worker backstop.
    const { executor, calls } = countingExecutor();
    const sweep = await svc.processPendingPiiScrubJobs({
      executor,
      staleThresholdMs: 5 * 60 * 1000,
    });
    expect(sweep.claimed).toBe(0);
    expect(sweep.recovered).toBe(1);

    // Tick 2: re-claim and resume. ONLY the unmarked items execute — there is
    // no cursor to restore; the content-addressed markers ARE the resume state.
    const resume = await svc.processPendingPiiScrubJobs({ executor });
    expect(resume.claimed).toBe(1);
    expect(resume.succeeded).toBe(1);
    expect(calls.sort()).toEqual(["c-3", "c-4"]);

    const row = await jobRow(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({
      itemsTotal: 4,
      itemsCompleted: 2,
      itemsSkipped: 2,
      itemsFailed: 0,
    });

    // Zero duplicate writes: exactly one marker row per item across the crash.
    const dump = await dbWrite.execute(
      `SELECT marker_key, COUNT(*) AS n FROM pii_scrub_markers GROUP BY marker_key;`,
    );
    const groups = (dump as { rows: Array<{ n: unknown }> }).rows;
    expect(groups).toHaveLength(4);
    for (const g of groups) expect(Number(g.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retry / failure semantics
// ---------------------------------------------------------------------------

describe("processPendingPiiScrubJobs — retry and failure classification", () => {
  test("a transient item failure burns one bounded attempt; the retry only re-runs the failed item", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["t-ok", "t-flaky"]),
    });

    const flaky = failingExecutor(new Set(["t-flaky"]));
    const run1 = await svc.processPendingPiiScrubJobs({ executor: flaky.executor });
    expect(run1.failed).toBe(1);
    expect(run1.succeeded).toBe(0);

    let row = await jobRow(job.id);
    expect(row?.status).toBe("pending"); // bounded retry with backoff, not terminal
    expect(Number(row?.attempts)).toBe(1);
    expect(String(row?.error)).toContain("t-flaky");
    // The item that succeeded IS marker-protected already.
    expect(await markersRepo.listByJob(ORG_A, job.id)).toHaveLength(1);

    await clearBackoff(job.id);
    const healthy = countingExecutor();
    const run2 = await svc.processPendingPiiScrubJobs({ executor: healthy.executor });
    expect(run2.succeeded).toBe(1);
    expect(healthy.calls).toEqual(["t-flaky"]); // t-ok skipped via its marker

    row = await jobRow(job.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toMatchObject({ itemsCompleted: 1, itemsSkipped: 1, itemsFailed: 0 });
  });

  test("exhausted attempts land the job in failed; the poisoned item stays unmarked (quarantined)", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["p-1"]),
      maxAttempts: 2,
    });

    const poison = failingExecutor(new Set(["p-1"]));
    await svc.processPendingPiiScrubJobs({ executor: poison.executor });
    await clearBackoff(job.id);
    await svc.processPendingPiiScrubJobs({ executor: poison.executor });

    const row = await jobRow(job.id);
    expect(row?.status).toBe("failed");
    expect(Number(row?.attempts)).toBe(2);
    expect(String(row?.error)).toContain("p-1");
    expect(await markersRepo.listByJob(ORG_A, job.id)).toHaveLength(0);
  });

  test("residue with no escalation handler fails closed on the rails — never marked done (throw-never-fabricate)", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: [
        {
          itemRef: "fc-1",
          content: "Jane Doe met the auditor on Tuesday.",
          candidateSpans: ["Jane Doe"],
        },
      ],
      maxAttempts: 1,
    });

    // The REAL tier-0 executor with NO escalation handler: the candidate is
    // residue tier-0 cannot judge, so the seam throws instead of fabricating.
    const stats = await svc.processPendingPiiScrubJobs({ executor: makeExecutor() });
    expect(stats.failed).toBe(1);

    const row = await jobRow(job.id);
    expect(row?.status).toBe("failed"); // loud, attributed failure...
    expect(String(row?.error)).toContain("fc-1");
    // ...and the content is quarantined: NO done-marker was written.
    expect(await markersRepo.listByJob(ORG_A, job.id)).toHaveLength(0);
  });

  test("a structurally-invalid payload fails PERMANENTLY without burning retries (#15737 lesson)", async () => {
    await dbWrite.execute(
      `INSERT INTO jobs (id, type, status, data, organization_id)
       VALUES ('00000000-0000-4000-8000-00000000d15a', '${svc.PII_SCRUB_JOB_TYPE}', 'pending',
               '{"nonsense": true}'::jsonb, '${ORG_A}');`,
    );
    const { executor, calls } = countingExecutor();
    const stats = await svc.processPendingPiiScrubJobs({ executor });

    expect(stats.claimed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(calls).toEqual([]);
    const row = await jobRow("00000000-0000-4000-8000-00000000d15a");
    expect(row?.status).toBe("failed");
    expect(Number(row?.attempts)).toBe(0); // zero retry churn
    expect(String(row?.error)).toContain("Invalid pii_scrub job data");
  });

  test("a payload org that disagrees with the row org NEVER executes (tenant tripwire)", async () => {
    const data = JSON.stringify({
      organizationId: ORG_B, // payload claims org B...
      userId: USER,
      rulesetVersion: RULESET,
      items: [{ itemRef: "x-1", content: "text" }],
    });
    await dbWrite.execute(
      `INSERT INTO jobs (id, type, status, data, organization_id)
       VALUES ('00000000-0000-4000-8000-00000000d15b', '${svc.PII_SCRUB_JOB_TYPE}', 'pending',
               '${data}'::jsonb, '${ORG_A}');`, // ...but the row belongs to org A
    );
    const { executor, calls } = countingExecutor();
    const stats = await svc.processPendingPiiScrubJobs({ executor });

    expect(stats.failed).toBe(1);
    expect(calls).toEqual([]);
    const row = await jobRow("00000000-0000-4000-8000-00000000d15b");
    expect(row?.status).toBe("failed");
    expect(String(row?.error)).toContain("organizationId");
  });

  test("drain-budget exhaustion requeues WITHOUT consuming the retry budget", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["b-1", "b-2"]),
    });

    // budgetMs=0: the deadline is already past when the first item is reached.
    const strangled = countingExecutor();
    const run1 = await svc.processPendingPiiScrubJobs({
      executor: strangled.executor,
      budgetMs: 0,
    });
    expect(run1.claimed).toBe(1);
    expect(run1.requeued).toBe(1);
    expect(run1.failed).toBe(0);
    expect(strangled.calls).toEqual([]);

    let row = await jobRow(job.id);
    expect(row?.status).toBe("pending");
    expect(Number(row?.attempts)).toBe(0); // no attempt burned

    await clearBackoff(job.id);
    const healthy = countingExecutor();
    const run2 = await svc.processPendingPiiScrubJobs({ executor: healthy.executor });
    expect(run2.succeeded).toBe(1);
    expect(healthy.calls.sort()).toEqual(["b-1", "b-2"]);
    row = await jobRow(job.id);
    expect(row?.status).toBe("completed");
  });

  test("a completed job is never re-swept by stale recovery", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["done-1"]),
    });
    await svc.processPendingPiiScrubJobs({ executor: makeExecutor() });
    expect((await jobRow(job.id))?.status).toBe("completed");

    const recovered = await jobsRepo.recoverStaleJobs({
      type: svc.PII_SCRUB_JOB_TYPE,
      staleThresholdMs: 0,
    });
    expect(recovered).toBe(0);
    expect((await jobRow(job.id))?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  test("one org's markers never skip another org's identical content", async () => {
    const shared = items(["shared-1"], () => "identical corpus line with bob@example.com");

    const jobA = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: shared,
    });
    await svc.processPendingPiiScrubJobs({ executor: makeExecutor() });
    expect((await jobRow(jobA.id))?.status).toBe("completed");
    expect(await markersRepo.listByJob(ORG_A, jobA.id)).toHaveLength(1);

    // Org B enqueues the SAME content under the SAME ruleset: its scrub MUST
    // still run (org A's marker is invisible to org B) and produce its own row.
    const jobB = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_B,
      userId: USER,
      rulesetVersion: RULESET,
      items: shared,
    });
    const { executor, calls } = countingExecutor();
    await svc.processPendingPiiScrubJobs({ executor });
    expect(calls).toEqual(["shared-1"]); // executed, NOT skipped cross-tenant
    expect((await jobRow(jobB.id))?.status).toBe("completed");
    expect((await jobRow(jobB.id))?.result).toMatchObject({ itemsCompleted: 1, itemsSkipped: 0 });

    // Same marker key, one row per org — the key space is tenant-scoped.
    const dump = await dbWrite.execute(
      `SELECT organization_id, marker_key FROM pii_scrub_markers ORDER BY organization_id;`,
    );
    const rows = (dump as { rows: Array<{ organization_id: string; marker_key: string }> }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].marker_key).toBe(rows[1].marker_key);
    expect(new Set(rows.map((r) => r.organization_id))).toEqual(new Set([ORG_A, ORG_B]));
  });

  test("a job is invisible to another org's progress reads", async () => {
    const job = await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["iso-1"]),
    });
    expect(await svc.getPiiScrubJobForOrg(job.id, ORG_B)).toBeUndefined();
    expect((await svc.getPiiScrubJobForOrg(job.id, ORG_A))?.id).toBe(job.id);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: exactly-once claim + marker race
// ---------------------------------------------------------------------------

describe("concurrency — exactly-once", () => {
  test("two workers claiming the same batch: exactly one wins the job", async () => {
    await svc.enqueuePiiScrubBatch({
      organizationId: ORG_A,
      userId: USER,
      rulesetVersion: RULESET,
      items: items(["cc-1"]),
    });

    const [w1, w2] = await Promise.all([
      jobsRepo.claimPendingJobs({ type: svc.PII_SCRUB_JOB_TYPE, limit: 5 }),
      jobsRepo.claimPendingJobs({ type: svc.PII_SCRUB_JOB_TYPE, limit: 5 }),
    ]);
    expect(w1.length + w2.length).toBe(1); // FOR UPDATE SKIP LOCKED claim
  });

  test("two workers finishing the same item: exactly one marker row is created", async () => {
    const key = markerKeyForContent("racy content", RULESET);
    const marker = {
      organization_id: ORG_A,
      marker_key: key,
      content_hash: key.split(":")[1],
      ruleset_version: RULESET,
      model_id: "tier0",
      tier0_only: true,
    };
    const [r1, r2] = await Promise.all([
      markersRepo.tryCreate(marker),
      markersRepo.tryCreate(marker),
    ]);
    expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1);

    const dump = await dbWrite.execute(
      `SELECT COUNT(*) AS n FROM pii_scrub_markers WHERE marker_key = '${key}';`,
    );
    expect(Number((dump as { rows: Array<{ n: unknown }> }).rows[0].n)).toBe(1);
  });
});
