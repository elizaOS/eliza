/**
 * Schema-validation tests for W1-D default packs.
 *
 * Per IMPL §3.4 verification:
 *   "Each pack registers without errors. Schema-validation tests pass per
 *    pack."
 *
 * Asserts every shipped record satisfies the Wave-1 `ScheduledTaskSeed`
 * contract (see `src/default-packs/contract-stubs.ts`) — required fields
 * present, enums valid, multi-gate composition well-formed.
 */

import { describe, expect, it } from "vitest";
import {
  DAILY_RHYTHM_PACK_KEY,
  DAILY_RHYTHM_RECORD_IDS,
  DEFAULT_CONSOLIDATION_POLICIES,
  DEFAULT_ESCALATION_LADDERS,
  FOLLOWUP_STARTER_PACK_KEY,
  HABIT_STARTER_KEYS,
  HABIT_STARTER_RECORDS,
  HABIT_STARTERS_PACK_KEY,
  INBOX_TRIAGE_REQUIRED_CAPABILITIES,
  INBOX_TRIAGE_STARTER_PACK_KEY,
  MORNING_BRIEF_PACK_KEY,
  QUIET_THRESHOLD_DAYS,
  QUIET_USER_WATCHER_PACK_KEY,
  dailyRhythmPack,
  followupStarterPack,
  getAllDefaultPacks,
  getDefaultEnabledPacks,
  getDefaultPack,
  getOfferedDefaultPacks,
  habitStartersPack,
  inboxTriageStarterPack,
  isInboxTriageEligible,
  morningBriefPack,
  quietUserWatcherPack,
} from "../src/default-packs/index.js";
import type {
  DefaultPack,
  ScheduledTaskKind,
  ScheduledTaskSeed,
} from "../src/default-packs/index.js";

const VALID_KINDS: ReadonlySet<ScheduledTaskKind> = new Set<ScheduledTaskKind>([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);

const VALID_TRIGGER_KINDS = new Set([
  "once",
  "cron",
  "interval",
  "relative_to_anchor",
  "during_window",
  "event",
  "manual",
  "after_task",
]);

const VALID_GATE_COMPOSE = new Set([undefined, "all", "any", "first_deny"]);

const VALID_SOURCES = new Set([
  "default_pack",
  "user_chat",
  "first_run",
  "plugin",
]);

function validateSeed(record: ScheduledTaskSeed): string[] {
  const errs: string[] = [];
  if (!record.kind) errs.push("missing kind");
  if (!VALID_KINDS.has(record.kind)) errs.push(`invalid kind: ${record.kind}`);
  if (
    typeof record.promptInstructions !== "string" ||
    record.promptInstructions.trim().length === 0
  ) {
    errs.push("promptInstructions empty");
  }
  if (!record.trigger) errs.push("missing trigger");
  else if (!VALID_TRIGGER_KINDS.has(record.trigger.kind))
    errs.push(`invalid trigger.kind: ${record.trigger.kind}`);
  if (!VALID_PRIORITIES.has(record.priority))
    errs.push(`invalid priority: ${record.priority}`);
  if (typeof record.respectsGlobalPause !== "boolean")
    errs.push("respectsGlobalPause must be boolean");
  if (!VALID_SOURCES.has(record.source))
    errs.push(`invalid source: ${record.source}`);
  if (!record.createdBy) errs.push("missing createdBy");
  if (typeof record.ownerVisible !== "boolean")
    errs.push("ownerVisible must be boolean");
  if (record.shouldFire) {
    if (!Array.isArray(record.shouldFire.gates))
      errs.push("shouldFire.gates must be array");
    if (!VALID_GATE_COMPOSE.has(record.shouldFire.compose))
      errs.push(`invalid shouldFire.compose: ${record.shouldFire.compose}`);
    for (const gate of record.shouldFire.gates) {
      if (!gate.kind) errs.push("shouldFire.gates[*].kind missing");
    }
  }
  if (record.completionCheck && !record.completionCheck.kind)
    errs.push("completionCheck.kind missing");
  if (record.subject) {
    if (
      ![
        "entity",
        "relationship",
        "thread",
        "document",
        "calendar_event",
        "self",
      ].includes(record.subject.kind)
    )
      errs.push(`invalid subject.kind: ${record.subject.kind}`);
    if (!record.subject.id) errs.push("subject.id missing");
  }
  if (record.idempotencyKey === "") errs.push("idempotencyKey empty");
  return errs;
}

function validatePack(pack: DefaultPack): string[] {
  const errs: string[] = [];
  if (!pack.key) errs.push("pack.key missing");
  if (!pack.label) errs.push("pack.label missing");
  if (!pack.description) errs.push("pack.description missing");
  if (typeof pack.defaultEnabled !== "boolean")
    errs.push("pack.defaultEnabled must be boolean");
  if (!Array.isArray(pack.records)) errs.push("pack.records must be array");
  for (const record of pack.records) {
    const recordErrs = validateSeed(record);
    if (recordErrs.length > 0) {
      errs.push(
        `[${(record.metadata?.recordKey as string | undefined) ?? "<unkeyed>"}] ${recordErrs.join("; ")}`,
      );
    }
  }
  return errs;
}

describe("W1-D default-pack registry — shape", () => {
  it("registers exactly 6 packs", () => {
    expect(getAllDefaultPacks().length).toBe(6);
  });

  it("registers the documented pack keys", () => {
    expect(getAllDefaultPacks().map((p) => p.key).sort()).toEqual(
      [
        DAILY_RHYTHM_PACK_KEY,
        FOLLOWUP_STARTER_PACK_KEY,
        HABIT_STARTERS_PACK_KEY,
        INBOX_TRIAGE_STARTER_PACK_KEY,
        MORNING_BRIEF_PACK_KEY,
        QUIET_USER_WATCHER_PACK_KEY,
      ].sort(),
    );
  });

  it("getDefaultPack(key) returns the matching pack or null", () => {
    expect(getDefaultPack(DAILY_RHYTHM_PACK_KEY)).toBe(dailyRhythmPack);
    expect(getDefaultPack("does-not-exist")).toBeNull();
  });

  it("getOfferedDefaultPacks returns all packs", () => {
    expect(getOfferedDefaultPacks().length).toBe(6);
  });
});

describe("W1-D default-pack registry — defaultEnabled gating", () => {
  it("habit-starters is offered but not auto-enabled", () => {
    expect(habitStartersPack.defaultEnabled).toBe(false);
    expect(
      getDefaultEnabledPacks({ connectorRegistry: null }).map((p) => p.key),
    ).not.toContain(HABIT_STARTERS_PACK_KEY);
  });

  it("inbox-triage-starter is gated by gmail capability", () => {
    expect(inboxTriageStarterPack.defaultEnabled).toBe(true);
    expect(inboxTriageStarterPack.requiredCapabilities).toEqual([
      "google.gmail.read",
    ]);
    // No registry → not auto-seeded
    expect(
      getDefaultEnabledPacks({ connectorRegistry: null }).map((p) => p.key),
    ).not.toContain(INBOX_TRIAGE_STARTER_PACK_KEY);
    // Registry without gmail → not auto-seeded
    expect(
      getDefaultEnabledPacks({
        connectorRegistry: {
          byCapability: () => [],
          get: () => null,
        },
      }).map((p) => p.key),
    ).not.toContain(INBOX_TRIAGE_STARTER_PACK_KEY);
    // Registry with gmail → auto-seeded
    expect(
      getDefaultEnabledPacks({
        connectorRegistry: {
          byCapability: (cap) =>
            cap === "google.gmail.read"
              ? [{ kind: "google", capabilities: ["google.gmail.read"] }]
              : [],
          get: () => null,
        },
      }).map((p) => p.key),
    ).toContain(INBOX_TRIAGE_STARTER_PACK_KEY);
  });

  it("daily-rhythm and morning-brief are always auto-enabled", () => {
    const enabled = getDefaultEnabledPacks({ connectorRegistry: null });
    expect(enabled.map((p) => p.key)).toEqual(
      expect.arrayContaining([
        DAILY_RHYTHM_PACK_KEY,
        MORNING_BRIEF_PACK_KEY,
        QUIET_USER_WATCHER_PACK_KEY,
        FOLLOWUP_STARTER_PACK_KEY,
      ]),
    );
  });
});

describe("W1-D default-pack registry — schema per pack", () => {
  for (const pack of [
    dailyRhythmPack,
    morningBriefPack,
    quietUserWatcherPack,
    followupStarterPack,
    inboxTriageStarterPack,
    habitStartersPack,
  ]) {
    it(`${pack.key} pack records validate`, () => {
      const errs = validatePack(pack);
      if (errs.length > 0) {
        console.error(`pack ${pack.key} failures:`, errs);
      }
      expect(errs).toEqual([]);
    });
  }
});

describe("W1-D consolidation policies", () => {
  it("registers wake.confirmed = merge, sortBy priority_desc", () => {
    const wake = DEFAULT_CONSOLIDATION_POLICIES.find(
      (policy) => policy.anchorKey === "wake.confirmed",
    );
    expect(wake).toBeDefined();
    expect(wake?.mode).toBe("merge");
    expect(wake?.sortBy).toBe("priority_desc");
  });

  it("registers bedtime.target = sequential, staggerMinutes 5", () => {
    const bedtime = DEFAULT_CONSOLIDATION_POLICIES.find(
      (policy) => policy.anchorKey === "bedtime.target",
    );
    expect(bedtime).toBeDefined();
    expect(bedtime?.mode).toBe("sequential");
    expect(bedtime?.staggerMinutes).toBe(5);
  });
});

describe("W1-D default escalation ladders", () => {
  it("priority_low_default has no steps", () => {
    expect(DEFAULT_ESCALATION_LADDERS.priority_low_default.steps).toEqual([]);
  });

  it("priority_medium_default has one 30-min in_app retry", () => {
    expect(DEFAULT_ESCALATION_LADDERS.priority_medium_default.steps).toEqual([
      { delayMinutes: 30, channelKey: "in_app", intensity: "normal" },
    ]);
  });

  it("priority_high_default has 3-step cross-channel ladder", () => {
    expect(DEFAULT_ESCALATION_LADDERS.priority_high_default.steps).toEqual([
      { delayMinutes: 0, channelKey: "in_app", intensity: "soft" },
      { delayMinutes: 15, channelKey: "push", intensity: "normal" },
      { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
    ]);
  });
});

describe("W1-D daily-rhythm pack", () => {
  it("ships gm + gn + checkin records with stable idempotency keys", () => {
    const idemKeys = dailyRhythmPack.records.map((r) => r.idempotencyKey);
    expect(idemKeys).toEqual(
      expect.arrayContaining([
        DAILY_RHYTHM_RECORD_IDS.gm,
        DAILY_RHYTHM_RECORD_IDS.gn,
        DAILY_RHYTHM_RECORD_IDS.checkin,
      ]),
    );
  });

  it("checkin record has user_replied_within completionCheck and onSkip pipeline", () => {
    const checkin = dailyRhythmPack.records.find(
      (r) => r.kind === "checkin",
    );
    expect(checkin?.completionCheck?.kind).toBe("user_replied_within");
    expect(checkin?.priority).toBe("medium");
    expect(checkin?.pipeline?.onSkip?.length ?? 0).toBeGreaterThan(0);
  });

  it("gm and gn fire on wake.confirmed and bedtime.target anchors", () => {
    const gm = dailyRhythmPack.records.find(
      (r) => r.idempotencyKey === DAILY_RHYTHM_RECORD_IDS.gm,
    );
    const gn = dailyRhythmPack.records.find(
      (r) => r.idempotencyKey === DAILY_RHYTHM_RECORD_IDS.gn,
    );
    expect(gm?.trigger).toMatchObject({
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
    });
    expect(gn?.trigger).toMatchObject({
      kind: "relative_to_anchor",
      anchorKey: "bedtime.target",
    });
  });
});

describe("W1-D habit-starters pack", () => {
  it("ships exactly 8 records", () => {
    expect(habitStartersPack.records.length).toBe(8);
    expect(HABIT_STARTER_RECORDS.length).toBe(8);
  });

  it("includes all 8 habit keys", () => {
    const recordKeys = habitStartersPack.records
      .map((r) => r.metadata?.recordKey as string | undefined)
      .filter(Boolean);
    expect(recordKeys.sort()).toEqual(
      Object.values(HABIT_STARTER_KEYS).sort(),
    );
  });

  it("stretch uses first_deny multi-gate composition with three gates", () => {
    const stretch = habitStartersPack.records.find(
      (r) => r.metadata?.recordKey === HABIT_STARTER_KEYS.stretch,
    );
    expect(stretch?.shouldFire?.compose).toBe("first_deny");
    expect(stretch?.shouldFire?.gates.map((g) => g.kind).sort()).toEqual(
      ["late_evening_skip", "stretch.walk_out_reset", "weekend_skip"],
    );
  });

  it("workout has high priority and a workout-blocker pipeline placeholder", () => {
    const workout = habitStartersPack.records.find(
      (r) => r.metadata?.recordKey === HABIT_STARTER_KEYS.workout,
    );
    expect(workout?.priority).toBe("high");
    expect(workout?.pipeline?.onComplete).toBeDefined();
    expect(workout?.metadata?.workoutBlockerPlaceholder).toBe(true);
  });
});

describe("W1-D inbox-triage capability gate", () => {
  it("isInboxTriageEligible returns false when registry is null", () => {
    expect(isInboxTriageEligible(null)).toBe(false);
    expect(isInboxTriageEligible(undefined)).toBe(false);
  });

  it("isInboxTriageEligible returns false when no gmail connector is registered", () => {
    expect(
      isInboxTriageEligible({
        byCapability: () => [],
        get: () => null,
      }),
    ).toBe(false);
  });

  it("isInboxTriageEligible returns true when google.gmail.read is registered", () => {
    expect(
      isInboxTriageEligible({
        byCapability: (cap) =>
          cap === "google.gmail.read"
            ? [{ kind: "google", capabilities: ["google.gmail.read"] }]
            : [],
        get: () => null,
      }),
    ).toBe(true);
  });

  it("required capability list is stable", () => {
    expect(INBOX_TRIAGE_REQUIRED_CAPABILITIES).toEqual(["google.gmail.read"]);
  });
});

describe("W1-D quiet-user-watcher", () => {
  it("ships the quiet threshold of 3 days", () => {
    expect(QUIET_THRESHOLD_DAYS).toBe(3);
  });
});
