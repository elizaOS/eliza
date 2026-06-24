/**
 * Per-job execution-timeout sizing — the cold-pull orphaning fix.
 *
 * `processJobType` wraps each job in `withTimeout(executeJob(job),
 * PER_JOB_TIMEOUT_MS)`. A freshly-pinned agent image cold-pulls in ~2.5 min on
 * the node (the leaf SSH `docker pull` allows up to PULL_TIMEOUT_MS = 300s in
 * docker-sandbox-provider). At the old 120s ceiling this wrapper aborted the
 * job's awaiter mid-pull — the job flipped toward failure even though the pull
 * was still landing the image in the node cache (retry churn + half-provisioned
 * state behind the tonight outage). 180s clears a cold pull with margin.
 *
 * This pins two things:
 *   1. PER_JOB_TIMEOUT_MS outlasts a representative cold pull (and stays within
 *      the daemon's watchdog-safe budget), and
 *   2. the actual `withTimeout` semantics: a create/pull that takes longer than
 *      the OLD 120s ceiling completes without timing out under the new ceiling,
 *      while a genuinely-hung create still times out.
 *
 * (2) runs at a SCALED-DOWN clock so it's instant: the durations preserve the
 * exact ordering invariant the production constant relies on
 * (oldCeiling < coldPull < newCeiling < hung), so the test proves the behavior
 * change without waiting minutes of real wall-clock.
 */
import { describe, expect, test } from "bun:test";

import { withTimeout } from "../utils/with-timeout";
import { PER_JOB_TIMEOUT_MS } from "./provisioning-jobs";

/** A cold `docker pull` of a freshly-pinned image takes ~2.5 min on the node. */
const COLD_PULL_MS = 150_000;
/** The old per-job ceiling that aborted the awaiter mid-pull. */
const OLD_PER_JOB_TIMEOUT_MS = 120_000;
/**
 * The daemon's whole-WORK-cycle budget (provisioning-worker WORK_CYCLE_TIMEOUT_MS).
 * PER_JOB_TIMEOUT_MS is kept <= this so a single job never reads as if it could
 * outlive the bounded work group, and the heartbeat watchdog window (300s) is
 * never threatened.
 */
const WORK_CYCLE_TIMEOUT_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PER_JOB_TIMEOUT_MS sizing (cold-pull orphaning fix)", () => {
  test("outlasts a cold image pull but stays within the watchdog-safe work budget", () => {
    // A ~2.5min cold pull must NOT be aborted mid-flight by the per-job wrapper.
    expect(PER_JOB_TIMEOUT_MS).toBeGreaterThan(COLD_PULL_MS);
    // The old 120s ceiling was SHORTER than a cold pull (the bug). The fix raises it.
    expect(PER_JOB_TIMEOUT_MS).toBeGreaterThan(OLD_PER_JOB_TIMEOUT_MS);
    // ...but never longer than the daemon's whole-work-cycle budget, so it can't
    // read as if a single job could outlive the bounded group / threaten the
    // 300s heartbeat watchdog.
    expect(PER_JOB_TIMEOUT_MS).toBeLessThanOrEqual(WORK_CYCLE_TIMEOUT_MS);
  });

  test("a create/pull longer than the OLD ceiling completes without timing out under the new ceiling", async () => {
    // Scale the production ordering down by 1000x so the test is instant while
    // preserving the exact invariant: OLD(120) < coldPull(150) < NEW(180).
    const scale = 1000;
    const newCeiling = PER_JOB_TIMEOUT_MS / scale; // 180ms
    const coldPullDuration = COLD_PULL_MS / scale; // 150ms — would have tripped the old 120ms ceiling

    // Sanity: this duration is longer than the old ceiling (so it WOULD have
    // timed out before the fix) but shorter than the new one.
    expect(coldPullDuration).toBeGreaterThan(OLD_PER_JOB_TIMEOUT_MS / scale);
    expect(coldPullDuration).toBeLessThan(newCeiling);

    // A create that takes longer than the old ceiling but finishes within the
    // new one resolves cleanly — the job is NOT aborted mid-pull.
    const createThatColdPulls = sleep(coldPullDuration).then(() => "provisioned" as const);
    const result = await withTimeout(createThatColdPulls, newCeiling, "job agent_provision");
    expect(result).toBe("provisioned");
  });

  test("a genuinely-hung create still times out", async () => {
    const scale = 1000;
    const newCeiling = PER_JOB_TIMEOUT_MS / scale; // 180ms

    // A create that hangs well past the ceiling (e.g. a wedged node) must still
    // be freed by the wrapper — the ceiling is a real backstop, not removed.
    const hungCreate = sleep(newCeiling * 3); // never resolves before the timeout
    await expect(withTimeout(hungCreate, newCeiling, "job agent_provision")).rejects.toThrow(
      /timed out/,
    );
  });
});
