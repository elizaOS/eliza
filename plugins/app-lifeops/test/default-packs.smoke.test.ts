/**
 * Smoke test for W1-D default packs.
 *
 * Per IMPL §3.4 verification:
 *   "Smoke: fresh user picks defaults → 24 hours of simulated time produces
 *    ≤ 6 expected nudges (gm + check-in + check-in followup if no reply +
 *    gn + morning brief + sleep recap from plugin-health, all consolidated
 *    on anchor where applicable)."
 *
 * The W1-A spine (`ScheduledTaskRunner`) does not exist in this worktree
 * yet, so the smoke is a **simulation**: we walk every owner-visible
 * record's trigger, inject the wake.confirmed and bedtime.target anchors,
 * apply consolidation policies to co-firing tasks, and count the resulting
 * user-facing nudges.
 *
 * The plugin-health (W1-B) sleep-recap pack is referenced as a phantom
 * record so the consolidation policy on `bedtime.target` is exercised even
 * though the W1-D package does not own it.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONSOLIDATION_POLICIES,
  dailyRhythmPack,
  followupStarterPack,
  getDefaultEnabledPacks,
  morningBriefPack,
  quietUserWatcherPack,
} from "../src/default-packs/index.js";
import type {
  AnchorConsolidationPolicy,
  ScheduledTaskSeed,
} from "../src/default-packs/index.js";

interface SimulatedFire {
  recordKey: string;
  packKey: string;
  ownerVisible: boolean;
  anchorKey?: string;
  fireMinuteOfDay: number;
  priority: "low" | "medium" | "high";
}

function priorityRank(priority: SimulatedFire["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

/**
 * Walk owner-visible records and produce a list of `SimulatedFire` events
 * for one wake/bedtime cycle. Anchor-based triggers fire at the anchor +
 * offset; everything else is skipped (the test cares about the consolidation
 * + 24h-budget invariants, not interval/cron firing).
 */
function simulateOneDay(args: {
  packs: ReadonlyArray<{ records: ReadonlyArray<ScheduledTaskSeed>; key: string }>;
  wakeMinuteOfDay: number;
  bedtimeMinuteOfDay: number;
}): SimulatedFire[] {
  const fires: SimulatedFire[] = [];
  for (const pack of args.packs) {
    for (const record of pack.records) {
      // Only count owner-visible records; watcher records that flag
      // ownerVisible:false do not contribute to the user-facing nudge count.
      if (record.trigger.kind === "relative_to_anchor") {
        const minuteOfDay =
          record.trigger.anchorKey === "wake.confirmed"
            ? args.wakeMinuteOfDay + record.trigger.offsetMinutes
            : record.trigger.anchorKey === "bedtime.target"
              ? args.bedtimeMinuteOfDay + record.trigger.offsetMinutes
              : null;
        if (minuteOfDay !== null) {
          fires.push({
            recordKey:
              (record.metadata?.recordKey as string | undefined) ?? "unknown",
            packKey: pack.key,
            ownerVisible: record.ownerVisible,
            anchorKey: record.trigger.anchorKey,
            fireMinuteOfDay: minuteOfDay,
            priority: record.priority,
          });
        }
      }
    }
  }
  return fires;
}

/**
 * Apply consolidation policies. Returns the list of *user-facing* nudges
 * (each consolidated batch counts as one nudge).
 *
 * Grouping key: `(anchorKey, fireMinuteOfDay)` — a single anchor can have
 * multiple co-fire moments (e.g. wake.confirmed +0 and wake.confirmed +30),
 * which produce separate consolidation batches even under merge mode.
 */
function applyConsolidation(
  fires: SimulatedFire[],
  policies: ReadonlyArray<AnchorConsolidationPolicy>,
): SimulatedFire[][] {
  const policyByAnchor = new Map<string, AnchorConsolidationPolicy>();
  for (const policy of policies) policyByAnchor.set(policy.anchorKey, policy);

  const byKey = new Map<string, SimulatedFire[]>();
  const standalone: SimulatedFire[][] = [];
  for (const fire of fires) {
    if (!fire.ownerVisible) continue;
    const anchor = fire.anchorKey;
    if (!anchor) {
      standalone.push([fire]);
      continue;
    }
    const policy = policyByAnchor.get(anchor);
    if (!policy) {
      standalone.push([fire]);
      continue;
    }
    const key = `${anchor}@${fire.fireMinuteOfDay}`;
    const list = byKey.get(key) ?? [];
    list.push(fire);
    byKey.set(key, list);
  }

  const result: SimulatedFire[][] = [...standalone];
  for (const [key, anchorFires] of byKey) {
    const anchor = key.split("@")[0]!;
    const policy = policyByAnchor.get(anchor)!;
    if (policy.mode === "merge") {
      const sorted = [...anchorFires].sort(
        (left, right) => priorityRank(right.priority) - priorityRank(left.priority),
      );
      result.push(sorted);
    } else if (policy.mode === "sequential") {
      for (const fire of anchorFires) result.push([fire]);
    } else {
      for (const fire of anchorFires) result.push([fire]);
    }
  }
  return result;
}

describe("W1-D default-pack smoke — 24h simulated nudge budget", () => {
  it("fresh user defaults path produces ≤ 6 user-facing nudges in one day", () => {
    const enabledPacks = getDefaultEnabledPacks({
      connectorRegistry: null,
    });

    // Add a phantom plugin-health sleep-recap record so the bedtime.target
    // consolidation policy is exercised. Wave-1 expects plugin-health to
    // ship this; W1-D's smoke test guards the consolidation invariant.
    const phantomSleepRecap: ScheduledTaskSeed = {
      kind: "recap",
      promptInstructions: "Phantom sleep recap (plugin-health W1-B record).",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: "bedtime.target",
        offsetMinutes: 0,
      },
      priority: "low",
      respectsGlobalPause: true,
      source: "plugin",
      createdBy: "plugin-health:sleep-recap",
      ownerVisible: true,
      idempotencyKey: "plugin-health:sleep-recap:nightly",
      metadata: { recordKey: "sleep-recap", packKey: "plugin-health:sleep-recap" },
    };
    const packs = [
      ...enabledPacks,
      { key: "plugin-health:sleep-recap", records: [phantomSleepRecap] },
    ];

    const fires = simulateOneDay({
      packs,
      wakeMinuteOfDay: 7 * 60,
      bedtimeMinuteOfDay: 23 * 60,
    });
    const nudges = applyConsolidation(fires, DEFAULT_CONSOLIDATION_POLICIES);

    expect(nudges.length).toBeLessThanOrEqual(6);
  });

  it("merge mode collapses gm + morning-brief + quiet-watcher + followup-watcher into one wake batch", () => {
    const fires = simulateOneDay({
      packs: [
        { key: dailyRhythmPack.key, records: dailyRhythmPack.records },
        { key: morningBriefPack.key, records: morningBriefPack.records },
        {
          key: quietUserWatcherPack.key,
          records: quietUserWatcherPack.records,
        },
        {
          key: followupStarterPack.key,
          records: followupStarterPack.records,
        },
      ],
      wakeMinuteOfDay: 7 * 60,
      bedtimeMinuteOfDay: 23 * 60,
    });
    const nudges = applyConsolidation(fires, DEFAULT_CONSOLIDATION_POLICIES);

    // wake.confirmed @ offset 0 has: gm + morning-brief (visible).
    // wake.confirmed @ offset 0 also has: quiet-watcher + followup-watcher
    // but ownerVisible=false on both, so they don't count toward nudges.
    // wake.confirmed @ offset 30 has: checkin (visible).
    const wakeBatches = nudges.filter((batch) =>
      batch.some((f) => f.anchorKey === "wake.confirmed"),
    );
    expect(wakeBatches.length).toBe(2); // offset-0 batch + offset-30 batch
    const offsetZeroBatch = wakeBatches.find(
      (batch) => batch[0]!.fireMinuteOfDay === 7 * 60,
    );
    expect(offsetZeroBatch).toBeDefined();
    // offset-0 visible: gm (low) + morning-brief (medium). Sorted priority_desc.
    expect(offsetZeroBatch!.map((f) => f.recordKey).sort()).toEqual(
      ["gm", "morning-brief"].sort(),
    );
    expect(offsetZeroBatch![0]!.priority).toBe("medium");
  });

  it("watcher tasks (ownerVisible=false) do not count toward the nudge budget", () => {
    const enabledPacks = getDefaultEnabledPacks({
      connectorRegistry: null,
    });
    const fires = simulateOneDay({
      packs: enabledPacks,
      wakeMinuteOfDay: 7 * 60,
      bedtimeMinuteOfDay: 23 * 60,
    });
    const watcherFires = fires.filter((f) => !f.ownerVisible);
    expect(watcherFires.length).toBeGreaterThan(0); // at least quiet + followup
    const nudges = applyConsolidation(fires, DEFAULT_CONSOLIDATION_POLICIES);
    const visibleAcrossNudges = nudges.flat().filter((f) => f.ownerVisible);
    expect(visibleAcrossNudges.length).toBe(nudges.flat().length);
  });
});
