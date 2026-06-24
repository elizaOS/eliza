/**
 * Per-job execution-timeout sizing — the cold-pull orphaning fix.
 *
 * `processJobType` wraps each job in `withTimeout(executeJob(job),
 * PER_JOB_TIMEOUT_MS)`. A freshly-pinned agent image cold-pulls in ~2.5 min on
 * the node, and the leaf SSH `docker pull` itself allows up to
 * PULL_TIMEOUT_MS = 300s in docker-sandbox-provider. At the old 120s ceiling
 * this wrapper aborted the job's awaiter mid-pull — the job flipped toward
 * failure even though the pull was still landing the image in the node cache
 * (retry churn + half-provisioned state behind the tonight outage). 300s
 * matches the leaf pull ceiling so the wrapper never cuts a still-progressing
 * cold pull short.
 *
 * This pins two things:
 *   1. PER_JOB_TIMEOUT_MS outlasts a representative cold pull and matches the
 *      leaf PULL_TIMEOUT_MS (the real ceiling that bounds a cold provision), and
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
// Import the provider's REAL pull ceiling so this test tracks the production
// constant (and goes red if either drifts), rather than asserting against a
// hand-copied literal that can silently diverge.
import { PULL_TIMEOUT_MS } from "./docker-sandbox-provider";
import { PER_JOB_TIMEOUT_MS } from "./provisioning-jobs";

/** A cold `docker pull` of a freshly-pinned image takes ~2.5 min on the node. */
const COLD_PULL_MS = 150_000;
/** The old per-job ceiling that aborted the awaiter mid-pull. */
const OLD_PER_JOB_TIMEOUT_MS = 120_000;
/**
 * The leaf SSH `docker pull` ceiling (docker-sandbox-provider PULL_TIMEOUT_MS).
 * PER_JOB_TIMEOUT_MS matches this so the outer per-job wrapper never cuts a
 * still-progressing cold pull short. This — NOT the daemon's work-cycle budget —
 * is the real ceiling that bounds a cold provision: on the watchdog's critical
 * path the per-job awaiter runs INSIDE the daemon's `runBoundedPhase("cycle")`
 * (capped at PHASE_TIMEOUT_MS = 60s), so the heartbeat advances regardless of
 * PER_JOB_TIMEOUT_MS, and the watchdog invariant
 * (WORK_CYCLE_TIMEOUT_MS 240s + poll 30s < WATCHDOG_MAX_CYCLE_MS 300s) does not
 * reference it. Raising PER_JOB_TIMEOUT_MS to 300s therefore stays watchdog-safe.
 *
 * `PULL_TIMEOUT_MS` is imported from `docker-sandbox-provider` (not redeclared)
 * so this assertion catches real drift in the provider's pull ceiling.
 */
/** Shared 1000x scale-down so the timing tests run instantly. */
const SCALE = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PER_JOB_TIMEOUT_MS sizing (cold-pull orphaning fix)", () => {
  test("outlasts a cold image pull and matches the leaf pull ceiling", () => {
    // A ~2.5min cold pull must NOT be aborted mid-flight by the per-job wrapper.
    expect(PER_JOB_TIMEOUT_MS).toBeGreaterThan(COLD_PULL_MS);
    // The old 120s ceiling was SHORTER than a cold pull (the bug). The fix raises it.
    expect(PER_JOB_TIMEOUT_MS).toBeGreaterThan(OLD_PER_JOB_TIMEOUT_MS);
    // ...up to the leaf SSH `docker pull` ceiling. Matching PULL_TIMEOUT_MS means
    // the outer wrapper never cuts a still-progressing cold pull short — and it
    // stays watchdog-safe because the per-job awaiter on the watchdog critical
    // path is bounded by the daemon's PHASE_TIMEOUT_MS (60s), not by this value.
    expect(PER_JOB_TIMEOUT_MS).toBeLessThanOrEqual(PULL_TIMEOUT_MS);
  });

  test("a create/pull longer than the OLD ceiling completes without timing out under the new ceiling", async () => {
    // Scale the production ordering down by 1000x so the test is instant while
    // preserving the exact invariant: OLD(120) < coldPull(150) < NEW(300).
    const newCeiling = PER_JOB_TIMEOUT_MS / SCALE; // 300ms
    const coldPullDuration = COLD_PULL_MS / SCALE; // 150ms — would have tripped the old 120ms ceiling

    // Sanity: this duration is longer than the old ceiling (so it WOULD have
    // timed out before the fix) but shorter than the new one.
    expect(coldPullDuration).toBeGreaterThan(OLD_PER_JOB_TIMEOUT_MS / SCALE);
    expect(coldPullDuration).toBeLessThan(newCeiling);

    // A create that takes longer than the old ceiling but finishes within the
    // new one resolves cleanly — the job is NOT aborted mid-pull.
    const createThatColdPulls = sleep(coldPullDuration).then(() => "provisioned" as const);
    const result = await withTimeout(createThatColdPulls, newCeiling, "job agent_provision");
    expect(result).toBe("provisioned");
  });

  test("a genuinely-hung create still times out", async () => {
    const newCeiling = PER_JOB_TIMEOUT_MS / SCALE; // 300ms

    // A create that hangs well past the ceiling (e.g. a wedged node) must still
    // be freed by the wrapper — the ceiling is a real backstop, not removed.
    const hungCreate = sleep(newCeiling * 3); // never resolves before the timeout
    await expect(withTimeout(hungCreate, newCeiling, "job agent_provision")).rejects.toThrow(
      /timed out/,
    );
  });
});
