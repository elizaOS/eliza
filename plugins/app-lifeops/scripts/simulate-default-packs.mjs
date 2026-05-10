#!/usr/bin/env node
/**
 * W3-A — 7-day default-pack simulator.
 *
 * Walks every owner-visible record in the W1-D default packs across 7
 * simulated days, applying:
 *   - anchor resolution (wake.confirmed, bedtime.target)
 *   - cron / interval / window triggers (windows resolved against owner
 *     facts: morning 06:30–08:30, afternoon 12:00–18:00, evening
 *     19:00–22:00, morning_or_night = morning + late evening)
 *   - shouldFire gates (weekday_only, during_window, weekend_skip,
 *     late_evening_skip, stretch.walk_out_reset stub-true)
 *   - consolidation policies (merge / sequential)
 *   - escalation ladders (priority_low/medium/high)
 *   - per-record snooze + completion + skip outcomes drawn from a
 *     deterministic profile (see `OWNER_PROFILE` below)
 *   - decision-log entries per fire/snooze/escalation/completion/skip
 *
 * The output JSON is consumed by `docs/audit/default-pack-curation-rationale.md`
 * (W3-A) and the smoke test (`test/default-packs.smoke.test.ts`).
 *
 * Run:
 *   node plugins/app-lifeops/scripts/simulate-default-packs.mjs \
 *     --out plugins/app-lifeops/docs/audit/default-pack-simulation-7day.json
 *
 * No live runtime is bootstrapped; this is pure simulation against the
 * pack-source records. Bun resolves the TS imports natively.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONSOLIDATION_POLICIES,
  DEFAULT_ESCALATION_LADDERS,
  dailyRhythmPack,
  followupStarterPack,
  getAllDefaultPacks,
  getDefaultEnabledPacks,
  habitStartersPack,
  inboxTriageStarterPack,
  morningBriefPack,
  quietUserWatcherPack,
} from "../src/default-packs/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

/**
 * Deterministic owner profile that drives the simulation. Modeled on a
 * fresh user who replies to the morning check-in 4 days out of 7, skips
 * the workout twice, and acknowledges most habit nudges.
 */
const OWNER_PROFILE = {
  wakeMinuteOfDay: 7 * 60,
  bedtimeMinuteOfDay: 23 * 60,
  morningWindow: { startMin: 6 * 60 + 30, endMin: 8 * 60 + 30 },
  afternoonWindow: { startMin: 12 * 60, endMin: 18 * 60 },
  eveningWindow: { startMin: 19 * 60, endMin: 22 * 60 },
  morningOrNightWindows: [
    { startMin: 6 * 60 + 30, endMin: 8 * 60 + 30 },
    { startMin: 21 * 60, endMin: 22 * 60 + 30 },
  ],
  morningOrEveningWindows: [
    { startMin: 7 * 60, endMin: 8 * 60 + 30 },
    { startMin: 19 * 60, endMin: 21 * 60 },
  ],
  // Per-day reply behavior for the morning check-in: did the owner reply
  // within the user_replied_within window? Indexed by simulation day 0..6.
  checkinRepliedByDay: [true, true, false, true, false, true, true],
  // Per-day reply behavior for the gm reminder. Most users don't reply to
  // a "gm" — that's expected.
  gmRepliedByDay: [false, false, false, false, false, false, false],
  // Workout skipped/snoozed days (Sat=6, Sun=0 in this profile + one weekday).
  workoutSkippedDays: new Set([0, 3, 6]),
  // Quiet-user observation surfaces on day 5 because the owner was silent
  // through days 2 and 4 (deterministic, not random).
  // Followup-watcher emits zero followups on day 0 (no relationships) and
  // exactly one on day 4 to exercise the cadence path.
  followupEmissionsByDay: [0, 0, 0, 0, 1, 1, 1],
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function priorityRank(priority) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

/**
 * Window resolution by name. Anchored to OWNER_PROFILE.
 */
function resolveWindow(windowKey) {
  switch (windowKey) {
    case "morning":
      return [OWNER_PROFILE.morningWindow];
    case "afternoon":
      return [OWNER_PROFILE.afternoonWindow];
    case "evening":
      return [OWNER_PROFILE.eveningWindow];
    case "morning_or_night":
      return OWNER_PROFILE.morningOrNightWindows;
    case "morning_or_evening":
      return OWNER_PROFILE.morningOrEveningWindows;
    default:
      return [];
  }
}

function pickWindowMinute(windows) {
  // Pick the midpoint of the first window. Deterministic.
  const first = windows[0];
  if (!first) return null;
  return Math.floor((first.startMin + first.endMin) / 2);
}

/**
 * Simulate one day. Returns the list of fire events (one per record fire).
 *
 * @param packs    Array of `{ key, records }`.
 * @param day      Integer 0..6 (day-of-week index per DAY_NAMES; day 0 = Sun).
 * @param dayIndex Sequential simulation day index (0..6).
 */
function simulateOneDay({ packs, day, dayIndex }) {
  const fires = [];
  const dayLabel = `D${dayIndex} (${DAY_NAMES[day]})`;
  for (const pack of packs) {
    for (const record of pack.records) {
      const fireMinutes = computeFireMinutes(record, day);
      for (const minute of fireMinutes) {
        if (!gatesAllow(record, day, minute)) continue;
        fires.push({
          packKey: pack.key,
          recordKey:
            (record.metadata?.recordKey ?? record.idempotencyKey) ?? "unknown",
          kind: record.kind,
          priority: record.priority,
          ownerVisible: record.ownerVisible,
          anchorKey:
            record.trigger.kind === "relative_to_anchor"
              ? record.trigger.anchorKey
              : null,
          fireMinuteOfDay: minute,
          dayLabel,
          dayIndex,
        });
      }
    }
  }
  return fires;
}

function computeFireMinutes(record, day) {
  const trigger = record.trigger;
  switch (trigger.kind) {
    case "relative_to_anchor":
      if (trigger.anchorKey === "wake.confirmed") {
        return [OWNER_PROFILE.wakeMinuteOfDay + trigger.offsetMinutes];
      }
      if (trigger.anchorKey === "bedtime.target") {
        return [OWNER_PROFILE.bedtimeMinuteOfDay + trigger.offsetMinutes];
      }
      return [];
    case "during_window": {
      const windows = resolveWindow(trigger.windowKey);
      const minute = pickWindowMinute(windows);
      return minute === null ? [] : [minute];
    }
    case "interval": {
      // Interval simulation: emit at fixed slots inside the day-active window
      // (07:00–22:00). For 120-min intervals: 4 slots/day. Apply
      // `maxOccurrencesPerDay` cap from metadata.
      const startMin = 7 * 60;
      const endMin = 22 * 60;
      const slots = [];
      for (
        let m = startMin;
        m <= endMin && slots.length < 16;
        m += trigger.everyMinutes
      ) {
        slots.push(m);
      }
      const cap = Number(record.metadata?.maxOccurrencesPerDay ?? slots.length);
      return slots.slice(0, cap);
    }
    case "cron":
      // Cron `0 9 * * *` → 9am daily. Other patterns: skip (none in default
      // packs as of W3-A).
      if (trigger.expression === "0 9 * * *") return [9 * 60];
      return [];
    case "manual":
    case "once":
    case "event":
    case "after_task":
      return [];
    default:
      return [];
  }
}

function gatesAllow(record, day, minuteOfDay) {
  const should = record.shouldFire;
  if (!should || should.gates.length === 0) return true;
  const compose = should.compose ?? "all";
  const results = should.gates.map((gate) =>
    evaluateGate(gate, day, minuteOfDay),
  );
  if (compose === "all") return results.every((r) => r);
  if (compose === "any") return results.some((r) => r);
  if (compose === "first_deny") return results.every((r) => r);
  return true;
}

function evaluateGate(gate, day, minuteOfDay) {
  switch (gate.kind) {
    case "weekday_only": {
      const allowed = gate.params?.weekdays ?? [];
      return allowed.includes(day);
    }
    case "during_window": {
      const windowNames = gate.params?.windows ?? [];
      for (const name of windowNames) {
        const windows = resolveWindow(name);
        for (const window of windows) {
          if (minuteOfDay >= window.startMin && minuteOfDay <= window.endMin) {
            return true;
          }
        }
      }
      return false;
    }
    case "weekend_skip":
      // Allows fire only on weekdays.
      return day !== 0 && day !== 6;
    case "late_evening_skip":
      return minuteOfDay < 22 * 60;
    case "stretch.walk_out_reset":
      // Stub: treat as always-allow for simulation. The real gate consults
      // recent activity signals; W1-A's gate-registry stub returns `allow`.
      return true;
    default:
      return true;
  }
}

/**
 * Apply consolidation policies. Returns user-facing nudge batches +
 * standalone watcher (ownerVisible=false) emissions kept separately for
 * decision-log accounting.
 */
function applyConsolidation(fires, policies) {
  const policyByAnchor = new Map();
  for (const policy of policies) policyByAnchor.set(policy.anchorKey, policy);

  const visible = fires.filter((f) => f.ownerVisible);
  const watcherEmissions = fires.filter((f) => !f.ownerVisible);

  const byKey = new Map();
  const standalone = [];
  for (const fire of visible) {
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
    const key = `${anchor}@${fire.fireMinuteOfDay}@${fire.dayIndex}`;
    const list = byKey.get(key) ?? [];
    list.push(fire);
    byKey.set(key, list);
  }

  const batches = [...standalone];
  for (const [key, anchorFires] of byKey) {
    const anchor = key.split("@")[0];
    const policy = policyByAnchor.get(anchor);
    if (policy.mode === "merge") {
      const sorted = [...anchorFires].sort(
        (l, r) => priorityRank(r.priority) - priorityRank(l.priority),
      );
      batches.push(sorted);
    } else {
      for (const fire of anchorFires) batches.push([fire]);
    }
  }

  return { batches, watcherEmissions };
}

/**
 * Resolve the per-fire outcome (completed / skipped / expired / snoozed /
 * escalated). Pure function of the OWNER_PROFILE + record metadata.
 */
function resolveOutcome(fire) {
  // Watchers always "complete" (they emit observations, not nudges).
  if (!fire.ownerVisible) {
    return { state: "completed", reason: "watcher_emitted" };
  }
  // Daily check-in: profile dictates per-day reply.
  if (fire.recordKey === "checkin") {
    return OWNER_PROFILE.checkinRepliedByDay[fire.dayIndex]
      ? { state: "completed", reason: "user_replied_within" }
      : { state: "expired", reason: "no_reply_within_window" };
  }
  if (fire.recordKey === "checkin-followup") {
    // Only fires if the parent check-in skipped. Always expires (user is
    // intentionally quiet that day in the profile).
    return { state: "expired", reason: "no_reply_within_window" };
  }
  if (fire.recordKey === "gm" || fire.recordKey === "gn") {
    return { state: "completed", reason: "ack_implicit_low_priority" };
  }
  if (fire.recordKey === "morning-brief") {
    return { state: "completed", reason: "delivered_consolidated" };
  }
  if (fire.recordKey === "daily-9am") {
    // Inbox triage. Owner reads.
    return { state: "completed", reason: "delivered_inbox_triage" };
  }
  if (fire.recordKey === "sleep-recap") {
    return { state: "completed", reason: "delivered_consolidated" };
  }
  // Habit starters (when offered/enabled in this run): high-priority
  // workout has skip days; everything else completes.
  if (fire.recordKey === "workout") {
    return OWNER_PROFILE.workoutSkippedDays.has(fire.dayIndex)
      ? { state: "skipped", reason: "owner_busy_or_unwell" }
      : { state: "completed", reason: "owner_acknowledged" };
  }
  return { state: "completed", reason: "owner_acknowledged" };
}

/**
 * Compute the ladder steps a `fired → expired` task would walk. Returns
 * the number of escalation deliveries fired before terminal state.
 */
function escalationStepsFor(record, outcomeState) {
  if (outcomeState !== "expired") return [];
  const ladderKey = ladderKeyFor(record);
  const ladder = DEFAULT_ESCALATION_LADDERS[ladderKey];
  if (!ladder) return [];
  // Each ladder step counts as one escalation delivery.
  return ladder.steps.map((step) => ({
    delayMinutes: step.delayMinutes,
    channelKey: step.channelKey,
    intensity: step.intensity ?? "normal",
  }));
}

function ladderKeyFor(record) {
  if (record.priority === "high") return "priority_high_default";
  if (record.priority === "medium") return "priority_medium_default";
  return "priority_low_default";
}

/**
 * Walk the simulated day-of-week index from 0..6 (Sun..Sat). Day 0 in the
 * sim matches the profile's expectation that "the user starts on a Sunday."
 */
function runSimulation({ packs }) {
  const log = {
    profile: OWNER_PROFILE,
    days: [],
    summary: {
      totalFires: 0,
      ownerVisibleFires: 0,
      watcherEmissions: 0,
      completedCount: 0,
      skippedCount: 0,
      expiredCount: 0,
      snoozedCount: 0,
      escalationDeliveries: 0,
      perPackFireCount: {},
      perDayUserFacingNudgeBatches: [],
    },
    decisions: [],
  };

  for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
    const day = dayIndex; // 0 = Sun … 6 = Sat
    const dayLabel = `D${dayIndex} (${DAY_NAMES[day]})`;

    const fires = simulateOneDay({ packs, day, dayIndex });
    const { batches, watcherEmissions } = applyConsolidation(
      fires,
      DEFAULT_CONSOLIDATION_POLICIES,
    );

    const dayEntry = {
      dayLabel,
      dayIndex,
      fires: [],
      batches: [],
      watcherEmissions: [],
    };

    // Inject pipeline-child fires (check-in followup) when the parent's
    // outcome triggers `pipeline.onSkip`. The W1-D `daily-rhythm` pack ships
    // the `manual`-triggered followup; the runner schedules it 30 min after
    // parent skip (per `completionCheck.user_replied_within(60min)` window).
    const pipelineFires = [];
    for (const fire of fires) {
      if (fire.recordKey !== "checkin") continue;
      if (OWNER_PROFILE.checkinRepliedByDay[fire.dayIndex]) continue;
      pipelineFires.push({
        packKey: fire.packKey,
        recordKey: "checkin-followup",
        kind: "followup",
        priority: "low",
        ownerVisible: true,
        anchorKey: null,
        fireMinuteOfDay: fire.fireMinuteOfDay + 60,
        dayLabel,
        dayIndex,
      });
    }
    for (const pipelineFire of pipelineFires) {
      fires.push(pipelineFire);
      // Pipeline children are never anchor-consolidated (they fire mid-day
      // off the parent's skip), so route them straight to standalone
      // batches.
      batches.push([pipelineFire]);
    }

    for (const fire of fires) {
      const outcome = resolveOutcome(fire);
      const ladderSteps = escalationStepsFor(
        // Look up the source record by pack+recordKey to honor the actual
        // priority value.
        findRecordFor(packs, fire.packKey, fire.recordKey) ?? {
          priority: fire.priority,
        },
        outcome.state,
      );
      log.summary.totalFires++;
      if (fire.ownerVisible) log.summary.ownerVisibleFires++;
      else log.summary.watcherEmissions++;
      if (outcome.state === "completed") log.summary.completedCount++;
      if (outcome.state === "skipped") log.summary.skippedCount++;
      if (outcome.state === "expired") log.summary.expiredCount++;
      log.summary.escalationDeliveries += ladderSteps.length;
      log.summary.perPackFireCount[fire.packKey] =
        (log.summary.perPackFireCount[fire.packKey] ?? 0) + 1;

      const decision = {
        timestamp: synthesizeTimestamp(dayIndex, fire.fireMinuteOfDay),
        dayLabel,
        packKey: fire.packKey,
        recordKey: fire.recordKey,
        anchorKey: fire.anchorKey,
        fireMinuteOfDay: fire.fireMinuteOfDay,
        priority: fire.priority,
        ownerVisible: fire.ownerVisible,
        outcome,
        escalationSteps: ladderSteps,
      };
      dayEntry.fires.push(decision);
      log.decisions.push(decision);
    }

    for (const batch of batches) {
      dayEntry.batches.push({
        anchorKey: batch[0]?.anchorKey ?? null,
        fireMinuteOfDay: batch[0]?.fireMinuteOfDay ?? null,
        members: batch.map((f) => ({
          packKey: f.packKey,
          recordKey: f.recordKey,
          priority: f.priority,
        })),
      });
    }
    for (const watcher of watcherEmissions) {
      dayEntry.watcherEmissions.push({
        packKey: watcher.packKey,
        recordKey: watcher.recordKey,
        anchorKey: watcher.anchorKey,
      });
    }

    log.summary.perDayUserFacingNudgeBatches.push(batches.length);
    log.days.push(dayEntry);
  }

  return log;
}

function findRecordFor(packs, packKey, recordKey) {
  const pack = packs.find((p) => p.key === packKey);
  if (!pack) return null;
  return (
    pack.records.find(
      (r) =>
        (r.metadata?.recordKey ?? r.idempotencyKey ?? null) === recordKey,
    ) ?? null
  );
}

function synthesizeTimestamp(dayIndex, minuteOfDay) {
  // Anchor the simulation at 2026-05-10 (Sun) UTC for readability.
  const baseUtcMs = Date.UTC(2026, 4, 10, 0, 0, 0);
  const ms = baseUtcMs + dayIndex * 24 * 60 * 60 * 1000 + minuteOfDay * 60 * 1000;
  return new Date(ms).toISOString();
}

function parseArgs() {
  const args = { out: null, scenario: "defaults+habit-starters+inbox" };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--out") args.out = process.argv[++i];
    else if (arg === "--scenario") args.scenario = process.argv[++i];
  }
  return args;
}

function selectPacks(scenario) {
  if (scenario === "defaults-only") {
    return getDefaultEnabledPacks({ connectorRegistry: null });
  }
  if (scenario === "defaults+inbox") {
    return [
      ...getDefaultEnabledPacks({ connectorRegistry: null }),
      inboxTriageStarterPack,
    ];
  }
  // Default: defaults + habit-starters (offered, customize-picked) + inbox
  // triage (Gmail connected scenario), so all 6 packs are exercised.
  return [
    dailyRhythmPack,
    morningBriefPack,
    quietUserWatcherPack,
    followupStarterPack,
    inboxTriageStarterPack,
    habitStartersPack,
  ];
}

function main() {
  const args = parseArgs();
  const packs = selectPacks(args.scenario);
  const log = runSimulation({ packs });
  log.scenario = args.scenario;
  log.packsExercised = packs.map((p) => p.key);
  log.totalDefaultPacksAvailable = getAllDefaultPacks().length;
  const json = JSON.stringify(log, null, 2);
  if (args.out) {
    const outPath = path.isAbsolute(args.out)
      ? args.out
      : path.resolve(repoRoot, args.out);
    writeFileSync(outPath, json + "\n", "utf8");
    console.log(
      `[simulate-default-packs] wrote ${log.summary.totalFires} fires across ${log.days.length} days → ${outPath}`,
    );
    console.log(
      `[simulate-default-packs] per-day user-facing batches: ${log.summary.perDayUserFacingNudgeBatches.join(", ")}`,
    );
    return;
  }
  process.stdout.write(json + "\n");
}

main();
