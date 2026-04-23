import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../../test/helpers/real-runtime";
import { resolveDefaultTimeZone } from "../src/lifeops/defaults.js";
import type { LifeOpsScheduleMergedStateRecord } from "../src/lifeops/repository.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { executeRawSql, toText } from "../src/lifeops/sql.js";
import {
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../src/lifeops/time.js";

const TIMEZONE = resolveDefaultTimeZone();

type CapturedAssistantEvent = {
  runId: string;
  stream: string;
  agentId?: string;
  data: Record<string, unknown>;
};

type EventServiceLike = {
  subscribe: (listener: (event: CapturedAssistantEvent) => void) => () => void;
  subscribeHeartbeat: () => () => void;
  emit: (
    event: Omit<CapturedAssistantEvent, "runId"> & { runId: string },
  ) => void;
};

type RuntimeWithPatchableServices = AgentRuntime & {
  getService: (serviceType: string) => unknown | null;
  useModel: (...args: unknown[]) => Promise<string>;
};

type Fixture = {
  runtime: AgentRuntime;
  service: LifeOpsService;
  events: CapturedAssistantEvent[];
  cleanup: () => Promise<void>;
};

function isoMinutesFrom(value: string, minutes: number): string {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}

function localDateParts(iso: string) {
  return getZonedDateParts(new Date(iso), TIMEZONE);
}

function localDateKey(iso: string): string {
  const parts = localDateParts(iso);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day,
  ).padStart(2, "0")}`;
}

function localDayBoundary(iso: string): { startAt: string; endAt: string } {
  const parts = localDateParts(iso);
  const start = buildUtcDateFromLocalParts(TIMEZONE, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const end = buildUtcDateFromLocalParts(TIMEZONE, {
    year: parts.year,
    month: parts.month,
    day: parts.day + 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  return {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  };
}

function normalizedLocalHour(iso: string, fallback: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const parts = getZonedDateParts(new Date(parsed), TIMEZONE);
  const hour = parts.hour + parts.minute / 60;
  return hour < 12 ? hour + 24 : hour;
}

function buildScheduleState(args: {
  agentId: string;
  nowIso: string;
  circadianState: LifeOpsScheduleMergedStateRecord["circadianState"];
  wakeAt: string | null;
  bedtimeTargetAt: string | null;
  minutesUntilBedtimeTarget: number | null;
  currentSleepStartedAt?: string | null;
}): LifeOpsScheduleMergedStateRecord {
  const nowMs = Date.parse(args.nowIso);
  const wakeMs = args.wakeAt ? Date.parse(args.wakeAt) : null;
  const dayBoundary = localDayBoundary(args.nowIso);
  const minutesSinceWake =
    wakeMs === null ? null : Math.round((nowMs - wakeMs) / 60_000);
  const isSleeping =
    args.circadianState === "sleeping" || args.circadianState === "napping";
  const pAwake = isSleeping ? 0.03 : 0.94;
  const pAsleep = isSleeping ? 0.94 : 0.03;

  return {
    id: `lifeops-schedule-merged:${args.agentId}:cloud:${TIMEZONE}`,
    agentId: args.agentId,
    scope: "cloud",
    effectiveDayKey: localDateKey(args.nowIso),
    localDate: localDateKey(args.nowIso),
    timezone: TIMEZONE,
    mergedAt: args.nowIso,
    inferredAt: args.nowIso,
    circadianState: args.circadianState,
    stateConfidence: 0.94,
    uncertaintyReason: null,
    relativeTime: {
      computedAt: args.nowIso,
      localNowAt: args.nowIso,
      circadianState: args.circadianState,
      stateConfidence: 0.94,
      uncertaintyReason: null,
      awakeProbability: {
        pAwake,
        pAsleep,
        pUnknown: 0.03,
        contributingSources: [{ source: "health", logLikelihoodRatio: 3 }],
        computedAt: args.nowIso,
      },
      wakeAnchorAt: args.wakeAt,
      wakeAnchorSource: args.wakeAt ? "sleep_cycle" : null,
      minutesSinceWake,
      minutesAwake: minutesSinceWake,
      bedtimeTargetAt: args.bedtimeTargetAt,
      bedtimeTargetSource: args.bedtimeTargetAt ? "typical_sleep" : null,
      minutesUntilBedtimeTarget: args.minutesUntilBedtimeTarget,
      minutesSinceBedtimeTarget: null,
      dayBoundaryStartAt: dayBoundary.startAt,
      dayBoundaryEndAt: dayBoundary.endAt,
      minutesSinceDayBoundaryStart:
        (nowMs - Date.parse(dayBoundary.startAt)) / 60_000,
      minutesUntilDayBoundaryEnd:
        (Date.parse(dayBoundary.endAt) - nowMs) / 60_000,
      confidence: 0.94,
    },
    awakeProbability: {
      pAwake,
      pAsleep,
      pUnknown: 0.03,
      contributingSources: [{ source: "health", logLikelihoodRatio: 3 }],
      computedAt: args.nowIso,
    },
    regularity: {
      sri: 0.81,
      bedtimeStddevMin: 20,
      wakeStddevMin: 20,
      midSleepStddevMin: 20,
      regularityClass: "regular",
      sampleCount: 8,
      windowDays: 14,
    },
    baseline: {
      medianWakeLocalHour: 7,
      medianBedtimeLocalHour: args.bedtimeTargetAt
        ? normalizedLocalHour(args.bedtimeTargetAt, 23)
        : 23,
      medianSleepDurationMin: 480,
      bedtimeStddevMin: 20,
      wakeStddevMin: 20,
      sampleCount: 8,
      windowDays: 14,
    },
    circadianRuleFirings: [
      {
        name: "test.sleep_cycle",
        contributes: args.circadianState,
        weight: 0.94,
        observedAt: args.nowIso,
        reason: "seeded integration test state",
      },
    ],
    sleepStatus: isSleeping ? "sleeping_now" : "slept",
    sleepConfidence: 0.94,
    currentSleepStartedAt: args.currentSleepStartedAt ?? null,
    lastSleepStartedAt: isSleeping
      ? (args.currentSleepStartedAt ?? isoMinutesFrom(args.nowIso, -60))
      : isoMinutesFrom(args.nowIso, -9 * 60),
    lastSleepEndedAt: isSleeping ? null : args.wakeAt,
    lastSleepDurationMinutes: isSleeping ? null : 480,
    wakeAt: args.wakeAt,
    firstActiveAt: args.wakeAt,
    lastActiveAt: isSleeping ? null : args.nowIso,
    meals: [],
    lastMealAt: null,
    nextMealLabel: null,
    nextMealWindowStartAt: null,
    nextMealWindowEndAt: null,
    nextMealConfidence: 0,
    observationCount: 1,
    deviceCount: 1,
    contributingDeviceKinds: ["cloud"],
    metadata: { test: "sleep-cycle-checkins" },
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  };
}

async function createFixture(name: string): Promise<Fixture> {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);

  const runtime = testRuntime.runtime as RuntimeWithPatchableServices;
  const originalGetService = runtime.getService.bind(runtime);
  const originalUseModel = runtime.useModel.bind(runtime);
  const events: CapturedAssistantEvent[] = [];
  const eventService: EventServiceLike = {
    subscribe: () => () => {},
    subscribeHeartbeat: () => () => {},
    emit: (event) => {
      events.push(event);
    },
  };

  runtime.getService = (serviceType: string) => {
    if (serviceType === "agent_event" || serviceType === "AGENT_EVENT") {
      return eventService;
    }
    return originalGetService(serviceType);
  };
  runtime.useModel = async () =>
    "Sleep-cycle check-in summary generated by the integration harness.";

  return {
    runtime: testRuntime.runtime,
    service: new LifeOpsService(testRuntime.runtime),
    events,
    cleanup: async () => {
      runtime.getService = originalGetService;
      runtime.useModel = originalUseModel;
      await testRuntime.cleanup();
    },
  };
}

async function seedSchedule(
  service: LifeOpsService,
  state: LifeOpsScheduleMergedStateRecord,
): Promise<void> {
  await service.repository.upsertScheduleMergedState(state);
  service.readEffectiveScheduleState = async () => null;
  service.refreshEffectiveScheduleState = async () => state;
}

async function listCheckinRows(runtime: AgentRuntime): Promise<
  Array<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
  }>
> {
  const rows = await executeRawSql(
    runtime,
    `SELECT id, kind, payload_json
       FROM life_checkin_reports
      ORDER BY generated_at_ms ASC`,
  );
  return rows.map((row) => ({
    id: toText(row.id),
    kind: toText(row.kind),
    payload: JSON.parse(toText(row.payload_json)) as Record<string, unknown>,
  }));
}

function checkinEvents(events: readonly CapturedAssistantEvent[]) {
  return events.filter(
    (event) =>
      event.stream === "assistant" && event.data.source === "lifeops-checkin",
  );
}

describe("LifeOps sleep-cycle check-in scheduler", () => {
  it("emits one morning check-in after wake confirmation and gates repeat ticks", async () => {
    const fixture = await createFixture("lifeops-morning-checkin-scheduler");
    try {
      const nowIso = "2026-04-22T08:00:00.000Z";
      await seedSchedule(
        fixture.service,
        buildScheduleState({
          agentId: String(fixture.runtime.agentId),
          nowIso,
          circadianState: "awake",
          wakeAt: "2026-04-22T07:00:00.000Z",
          bedtimeTargetAt: "2026-04-22T23:00:00.000Z",
          minutesUntilBedtimeTarget: 15 * 60,
        }),
      );

      await fixture.service.processScheduledWork({ now: nowIso });

      const firstEvents = checkinEvents(fixture.events);
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0].data).toMatchObject({
        checkinKind: "morning",
        deliveryBasis: "sleep_cycle",
        circadianState: "awake",
        wakeAt: "2026-04-22T07:00:00.000Z",
      });

      const firstRows = await listCheckinRows(fixture.runtime);
      expect(firstRows.map((row) => row.kind)).toEqual(["morning"]);
      expect(firstRows[0].payload.summaryText).toBe(
        "Sleep-cycle check-in summary generated by the integration harness.",
      );

      await fixture.service.processScheduledWork({
        now: "2026-04-22T08:05:00.000Z",
      });

      expect(checkinEvents(fixture.events)).toHaveLength(1);
      expect(await listCheckinRows(fixture.runtime)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("emits the night check-in inside the three-hour predicted bedtime window", async () => {
    const fixture = await createFixture("lifeops-night-checkin-scheduler");
    try {
      const nowIso = "2026-04-22T20:00:00.000Z";
      await seedSchedule(
        fixture.service,
        buildScheduleState({
          agentId: String(fixture.runtime.agentId),
          nowIso,
          circadianState: "awake",
          wakeAt: "2026-04-22T07:00:00.000Z",
          bedtimeTargetAt: "2026-04-22T22:30:00.000Z",
          minutesUntilBedtimeTarget: 150,
        }),
      );

      await fixture.service.processScheduledWork({ now: nowIso });

      const events = checkinEvents(fixture.events);
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        checkinKind: "night",
        deliveryBasis: "sleep_cycle",
        circadianState: "awake",
        bedtimeTargetAt: "2026-04-22T22:30:00.000Z",
        minutesUntilBedtimeTarget: 150,
      });
      expect(
        (await listCheckinRows(fixture.runtime)).map((row) => row.kind),
      ).toEqual(["night"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not emit a check-in while the owner is sleeping", async () => {
    const fixture = await createFixture("lifeops-sleeping-checkin-scheduler");
    try {
      const nowIso = "2026-04-22T03:00:00.000Z";
      await seedSchedule(
        fixture.service,
        buildScheduleState({
          agentId: String(fixture.runtime.agentId),
          nowIso,
          circadianState: "sleeping",
          wakeAt: null,
          bedtimeTargetAt: null,
          minutesUntilBedtimeTarget: null,
          currentSleepStartedAt: "2026-04-21T23:00:00.000Z",
        }),
      );

      await fixture.service.processScheduledWork({ now: nowIso });

      expect(checkinEvents(fixture.events)).toEqual([]);
      expect(await listCheckinRows(fixture.runtime)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
