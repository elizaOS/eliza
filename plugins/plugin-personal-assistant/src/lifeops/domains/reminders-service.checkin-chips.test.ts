/**
 * Night sleep-cycle delivery carries one-tap ack chips and honest delivery
 * accounting. The marker builder itself is pinned by
 * lifeops-choice-markers.test.ts; this suite covers the dispatch wiring with a
 * mocked check-in engine so generated reports only become day-done markers
 * after an app stream or connector accepts the message. Real sleep-cycle timing
 * also proves wake projections cannot bypass managed morning dossier admission.
 */
import { parseInteractionBlocks } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelRegistry,
  registerChannelRegistry,
} from "../channels/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type RemindersDeps,
  RemindersDomain,
  type SleepCycleCheckinDeliveryReport,
} from "./reminders-service.js";

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
  persistCheckinReport: vi.fn(async () => undefined),
}));

vi.mock("../checkin/checkin-service.js", () => ({
  CheckinService: class {
    hasCheckinForLocalDay = checkinMocks.hasCheckinForLocalDay;
    runMorningCheckin = checkinMocks.runMorningCheckin;
    runNightCheckin = checkinMocks.runNightCheckin;
    persistCheckinReport = checkinMocks.persistCheckinReport;
  },
}));

vi.mock("../checkin/schedule-resolver.js", () => ({
  resolveCheckinSchedule: vi.fn(async () => ({
    nightCheckinTime: "23:00",
  })),
}));

const NOW = new Date("2026-07-05T22:40:00.000Z");

const routeCandidates = [
  {
    channel: "in_app",
    score: 450,
    evidence: ["default in-app anchor"],
    vetoReasons: [],
    interruptionBudget: "normal",
  },
];

function makeDomain(
  contactRouteCandidates: Array<Record<string, unknown>> = routeCandidates,
) {
  const emitAssistantEvent = vi.fn(() => true);
  const runtime = { emitEvent: vi.fn(async () => undefined) };
  const ctx = {
    runtime,
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
  ).buildOwnerContactRouteEventMetadata = vi.fn(async () => ({
    contactRoutePurpose: "checkin",
    contactRouteCandidates,
  }));
  return { domain, emitAssistantEvent, runtime };
}

const currentSchedule = {
  timezone: "UTC",
  circadianState: "awake",
  baseline: null,
  regularity: { regularityClass: "regular", sri: 80 },
  wakeAt: "2026-07-05T07:00:00.000Z",
  relativeTime: {
    bedtimeTargetAt: "2026-07-05T23:00:00.000Z",
    minutesUntilBedtimeTarget: 20,
  },
} as never;

function runSleepCycleCheckins(
  domain: RemindersDomain,
  now = NOW,
  schedule = currentSchedule,
): Promise<SleepCycleCheckinDeliveryReport[]> {
  return (
    domain as unknown as {
      processSleepCycleCheckins(args: {
        now: Date;
        currentSchedule: unknown;
      }): Promise<SleepCycleCheckinDeliveryReport[]>;
    }
  ).processSleepCycleCheckins({ now, currentSchedule: schedule });
}

beforeEach(() => {
  checkinMocks.hasCheckinForLocalDay.mockClear();
  checkinMocks.hasCheckinForLocalDay.mockResolvedValue(false);
  checkinMocks.runMorningCheckin.mockClear();
  checkinMocks.runNightCheckin.mockClear();
  checkinMocks.persistCheckinReport.mockClear();
});

describe("sleep-cycle check-in dispatch (#14702, #14733)", () => {
  it("does not generate or deliver a morning dossier from a wake projection", async () => {
    const { domain, emitAssistantEvent } = makeDomain();
    await runSleepCycleCheckins(domain, new Date("2026-07-05T08:00:00.000Z"), {
      timezone: "UTC",
      circadianState: "awake",
      wakeAt: "2026-07-05T07:00:00.000Z",
      baseline: null,
      regularity: { regularityClass: "regular", sri: 80 },
      relativeTime: {
        bedtimeTargetAt: "2026-07-05T23:00:00.000Z",
        minutesUntilBedtimeTarget: 900,
      },
    } as never);
    expect(checkinMocks.runMorningCheckin).not.toHaveBeenCalled();
    expect(checkinMocks.runNightCheckin).not.toHaveBeenCalled();
    expect(emitAssistantEvent).not.toHaveBeenCalled();
    expect(checkinMocks.persistCheckinReport).not.toHaveBeenCalled();
  });

  it("emits the night summary with ack chips and persists only after the assistant stream accepts it", async () => {
    const { domain, emitAssistantEvent } = makeDomain();

    expect(await runSleepCycleCheckins(domain)).toEqual([
      expect.objectContaining({
        kind: "night",
        status: "delivered",
        persisted: true,
        reportId: "rep-night-1",
      }),
    ]);

    expect(checkinMocks.runNightCheckin).toHaveBeenCalledTimes(1);
    expect(checkinMocks.runNightCheckin).toHaveBeenCalledWith(
      expect.objectContaining({ now: NOW, timezone: "UTC", persist: false }),
    );
    expect(checkinMocks.hasCheckinForLocalDay).toHaveBeenCalledWith({
      kind: "night",
      now: NOW,
      timezone: "UTC",
    });
    expect(checkinMocks.runMorningCheckin).not.toHaveBeenCalled();
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [text, source, data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(source).toBe("lifeops-checkin");
    expect(data.reportId).toBe("rep-night-1");
    expect(text).toContain("Night recap.");
    const { blocks } = parseInteractionBlocks(text);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toMatchObject({
      kind: "choice",
      scope: "checkin-rep-night-1",
      id: "rep-night-1",
    });
    if (block?.kind !== "choice") throw new Error("expected choice block");
    // "All good" is a direct owner reply; details/snooze carry the report id.
    expect(block.options.map((o) => o.value)).toEqual([
      "All good",
      "details rep-night-1",
      "snooze rep-night-1",
    ]);
    expect(checkinMocks.persistCheckinReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: "rep-night-1" }),
      NOW,
    );
    expect(
      checkinMocks.persistCheckinReport.mock.invocationCallOrder[0],
    ).toBeGreaterThan(emitAssistantEvent.mock.invocationCallOrder[0]);
  });

  it("skips the emit and persist entirely when the day's check-in already went out", async () => {
    checkinMocks.hasCheckinForLocalDay.mockResolvedValue(true);
    const { domain, emitAssistantEvent } = makeDomain();

    await runSleepCycleCheckins(domain);

    expect(checkinMocks.runNightCheckin).not.toHaveBeenCalled();
    expect(emitAssistantEvent).not.toHaveBeenCalled();
    expect(checkinMocks.persistCheckinReport).not.toHaveBeenCalled();
  });

  it("does not persist a generated report when no delivery surface accepts it", async () => {
    const { domain, emitAssistantEvent } = makeDomain();
    emitAssistantEvent.mockReturnValue(false);

    await runSleepCycleCheckins(domain);

    expect(checkinMocks.runNightCheckin).toHaveBeenCalledTimes(1);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    expect(checkinMocks.persistCheckinReport).not.toHaveBeenCalled();
  });

  it("falls through from unavailable in-app delivery to the next connector route before persisting", async () => {
    const smsSend = vi.fn(async () => ({ ok: true, messageId: "sms-1" }));
    const { domain, emitAssistantEvent, runtime } = makeDomain([
      ...routeCandidates,
      {
        channel: "sms",
        score: 320,
        evidence: ["primary direct policy"],
        vetoReasons: [],
        interruptionBudget: "normal",
      },
    ]);
    emitAssistantEvent.mockReturnValue(false);
    const registry = createChannelRegistry();
    registry.register({
      kind: "sms",
      describe: { label: "SMS" },
      capabilities: {
        send: true,
        read: false,
        reminders: true,
        voice: false,
        attachments: false,
        quietHoursAware: true,
      },
      send: smsSend,
    });
    registerChannelRegistry(runtime as never, registry);
    (
      domain as unknown as {
        resolvePrimaryChannelPolicy: RemindersDomain["resolvePrimaryChannelPolicy"];
      }
    ).resolvePrimaryChannelPolicy = vi.fn(async () => ({
      id: "policy-sms",
      agentId: "00000000-0000-0000-0000-0000000000dd",
      channelType: "sms",
      channelRef: "+15551230000",
      enabled: true,
      priority: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      metadata: {},
    }));

    await runSleepCycleCheckins(domain);

    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    expect(smsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "+15551230000",
        message: expect.stringContaining("Night recap."),
        metadata: expect.objectContaining({
          checkinKind: "night",
          reportId: "rep-night-1",
        }),
      }),
    );
    expect(checkinMocks.persistCheckinReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: "rep-night-1" }),
      NOW,
    );
    expect(
      checkinMocks.persistCheckinReport.mock.invocationCallOrder[0],
    ).toBeGreaterThan(smsSend.mock.invocationCallOrder[0]);
  });
});

it("returns rejected delivery evidence without persisting a day-done marker", async () => {
  const { domain, emitAssistantEvent } = makeDomain();
  emitAssistantEvent.mockReturnValue(false);
  const reports = await runSleepCycleCheckins(domain);
  expect(reports).toEqual([
    expect.objectContaining({
      kind: "night",
      status: "disconnected",
      persisted: false,
      reportId: "rep-night-1",
    }),
  ]);
  expect(checkinMocks.persistCheckinReport).not.toHaveBeenCalled();
});

it("distinguishes a previously persisted night report from a failed attempt", async () => {
  const { domain, emitAssistantEvent } = makeDomain();
  checkinMocks.hasCheckinForLocalDay.mockResolvedValue(true);
  expect(await runSleepCycleCheckins(domain)).toEqual([
    expect.objectContaining({
      status: "skipped_already_sent",
      persisted: false,
    }),
  ]);
  expect(emitAssistantEvent).not.toHaveBeenCalled();
});
