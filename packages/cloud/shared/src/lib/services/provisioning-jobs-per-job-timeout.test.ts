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
import { HEALTH_CHECK_TIMEOUT_MS, PULL_TIMEOUT_MS } from "./docker-sandbox-provider";
import { JOB_TYPES } from "./provisioning-job-types";
import { PER_JOB_TIMEOUT_MS, resolvePerJobTimeoutMs } from "./provisioning-jobs";

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

/**
 * Cold-boot-aware per-job timeout (#10919). The flat PER_JOB_TIMEOUT_MS (300s)
 * matches only the leaf `docker pull` ceiling, not a FULL cold boot
 * (pull + agent health-check ≈ up to 11 min). At the flat 300s the wrap rejected
 * a slow cold provision mid-boot → incrementAttempt flipped it to `pending` → a
 * later poll re-claimed it → a second provision force-removed the first
 * still-booting container. `resolvePerJobTimeoutMs` fixes this by giving cold-boot
 * job types the full boot budget.
 */
describe("resolvePerJobTimeoutMs — cold-boot job types outlast a full boot (#10919)", () => {
  /** The real worst-case cold boot: image pull + agent health-check. */
  const FULL_COLD_BOOT_MS = PULL_TIMEOUT_MS + HEALTH_CHECK_TIMEOUT_MS;

  test("AGENT_PROVISION's per-job timeout exceeds the full cold-boot budget", () => {
    const timeout = resolvePerJobTimeoutMs(JOB_TYPES.AGENT_PROVISION);
    // Must clear pull(300s) + health(360s) ≈ 11 min so the wrap can't fire
    // before a legitimate cold boot finishes (the flat 300s did not).
    expect(timeout).toBeGreaterThanOrEqual(FULL_COLD_BOOT_MS);
    expect(timeout).toBeGreaterThan(PER_JOB_TIMEOUT_MS);
  });

  test("every cold-boot lifecycle type gets the extended budget", () => {
    for (const type of [
      JOB_TYPES.AGENT_PROVISION,
      JOB_TYPES.AGENT_RESUME,
      JOB_TYPES.AGENT_WAKE,
      JOB_TYPES.AGENT_RESTART,
      JOB_TYPES.AGENT_UPGRADE,
      JOB_TYPES.AGENT_DOWNGRADE,
    ]) {
      expect(resolvePerJobTimeoutMs(type)).toBeGreaterThanOrEqual(FULL_COLD_BOOT_MS);
    }
  });

  test("fast ops (e.g. AGENT_DELETE) keep the tight flat ceiling", () => {
    expect(resolvePerJobTimeoutMs(JOB_TYPES.AGENT_DELETE)).toBe(PER_JOB_TIMEOUT_MS);
    // An unknown/non-lifecycle type also falls back to the flat ceiling.
    expect(resolvePerJobTimeoutMs("some_other_job")).toBe(PER_JOB_TIMEOUT_MS);
  });

  test("EVERY non-cold-boot job type resolves to exactly the flat ceiling — the budget split is complete", () => {
    // Set-completeness over the whole JOB_TYPES surface (the spot checks above
    // can't catch it): a future type accidentally classified cold-boot would
    // let a hung job monopolize a worker slot for ~11 min; a cold-boot type
    // accidentally dropped would re-open the mid-boot abort this file exists
    // to prevent — e.g. the agent_provision job a tier-upgrade target's first
    // boot rides (#15943).
    const coldBoot = new Set<string>([
      JOB_TYPES.AGENT_PROVISION,
      JOB_TYPES.AGENT_RESUME,
      JOB_TYPES.AGENT_WAKE,
      JOB_TYPES.AGENT_RESTART,
      JOB_TYPES.AGENT_UPGRADE,
      JOB_TYPES.AGENT_DOWNGRADE,
    ]);
    for (const type of Object.values(JOB_TYPES)) {
      if (coldBoot.has(type)) continue;
      expect(resolvePerJobTimeoutMs(type)).toBe(PER_JOB_TIMEOUT_MS);
    }
  });
});
