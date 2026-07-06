/**
 * Sleep-cycle check-in delivery carries one-tap ack chips (#14733): the
 * morning/night summary emitted onto the assistant stream must end with a
 * `[CHOICE:checkin-<reportId>]` block. The marker builder itself is pinned by
 * lifeops-choice-markers.test.ts; this suite covers the DISPATCH wiring —
 * deterministic vitest with the check-in engine and sleep-cycle predicates
 * mocked, so only summary+chips → emitAssistantEvent is under test.
 */
import { parseInteractionBlocks } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

const checkinMocks = vi.hoisted(() => ({
  hasCheckinForLocalDay: vi.fn(async () => false),
  runMorningCheckin: vi.fn(async () => ({
    reportId: "rep-morning-1",
    summaryText: "Morning! 2 meetings today, 1 overdue todo.",
    escalationLevel: 0,
  })),
  runNightCheckin: vi.fn(async () => ({
    reportId: "rep-night-1",
    summaryText: "Night recap.",
    escalationLevel: 0,
  })),
}));

vi.mock("../checkin/checkin-service.js", () => ({
  CheckinService: class {
    hasCheckinForLocalDay = checkinMocks.hasCheckinForLocalDay;
    runMorningCheckin = checkinMocks.runMorningCheckin;
    runNightCheckin = checkinMocks.runNightCheckin;
  },
}));

vi.mock("../checkin/schedule-resolver.js", () => ({
  resolveCheckinSchedule: vi.fn(async () => ({
    nightCheckinTime: "23:00",
  })),
}));

vi.mock("@elizaos/plugin-health", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@elizaos/plugin-health")>();
  return {
    ...actual,
    buildSleepRecapFromSchedule: vi.fn(() => undefined),
    shouldRunMorningCheckinFromSleepCycle: vi.fn(() => true),
    shouldRunNightCheckinFromSleepCycle: vi.fn(() => false),
  };
});

const NOW = new Date("2026-07-05T08:00:00.000Z");

function makeDomain() {
  const emitAssistantEvent = vi.fn();
  const ctx = {
    runtime: { emitEvent: vi.fn(async () => undefined) },
    repository: {},
    agentId: () => "00000000-0000-0000-0000-0000000000dd",
    emitAssistantEvent,
    logLifeOpsWarn: vi.fn(),
    logLifeOpsError: vi.fn(),
  };
  const deps = {
    runDueWorkflows: vi.fn(async () => []),
    runDueEventWorkflows: vi.fn(async () => []),
    snoozeOccurrence: vi.fn(),
    checkinSource: {},
  };
  const domain = new RemindersDomain(
    ctx as unknown as LifeOpsContext,
    deps as unknown as RemindersDeps,
  );
  // TS `private` is compile-time only — stub the contact-route lookup so the
  // dispatch path needs no owner-contacts fixture.
  (
    domain as unknown as {
      buildOwnerContactRouteEventMetadata: unknown;
    }
  ).buildOwnerContactRouteEventMetadata = vi.fn(async () => ({}));
  return { domain, emitAssistantEvent };
}

const currentSchedule = {
  timezone: "UTC",
  circadianState: "awake",
  wakeAt: "2026-07-05T07:00:00.000Z",
  relativeTime: {
    bedtimeTargetAt: "2026-07-05T23:00:00.000Z",
    minutesUntilBedtimeTarget: 900,
  },
} as never;

function runSleepCycleCheckins(domain: RemindersDomain): Promise<void> {
  return (
    domain as unknown as {
      processSleepCycleCheckins(args: {
        now: Date;
        currentSchedule: unknown;
      }): Promise<void>;
    }
  ).processSleepCycleCheckins({ now: NOW, currentSchedule });
}

beforeEach(() => {
  checkinMocks.hasCheckinForLocalDay.mockClear();
  checkinMocks.hasCheckinForLocalDay.mockResolvedValue(false);
  checkinMocks.runMorningCheckin.mockClear();
});

describe("sleep-cycle check-in dispatch (#14733)", () => {
  it("emits the morning summary with ack chips onto the assistant stream", async () => {
    const { domain, emitAssistantEvent } = makeDomain();

    await runSleepCycleCheckins(domain);

    expect(checkinMocks.runMorningCheckin).toHaveBeenCalledTimes(1);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [text, source, data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(source).toBe("lifeops-checkin");
    expect(data.reportId).toBe("rep-morning-1");
    expect(text).toContain("Morning! 2 meetings today, 1 overdue todo.");
    const { blocks } = parseInteractionBlocks(text);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toMatchObject({
      kind: "choice",
      scope: "checkin-rep-morning-1",
      id: "rep-morning-1",
    });
    if (block?.kind !== "choice") throw new Error("expected choice block");
    // "All good" is a direct owner reply; details/snooze carry the report id.
    expect(block.options.map((o) => o.value)).toEqual([
      "All good",
      "details rep-morning-1",
      "snooze rep-morning-1",
    ]);
  });

  it("skips the emit entirely when the day's check-in already went out", async () => {
    checkinMocks.hasCheckinForLocalDay.mockResolvedValue(true);
    const { domain, emitAssistantEvent } = makeDomain();

    await runSleepCycleCheckins(domain);

    expect(checkinMocks.runMorningCheckin).not.toHaveBeenCalled();
    expect(emitAssistantEvent).not.toHaveBeenCalled();
  });
});
