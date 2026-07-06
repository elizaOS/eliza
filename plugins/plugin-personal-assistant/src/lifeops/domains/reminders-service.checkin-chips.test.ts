/**
 * Sleep-cycle check-in delivery carries one-tap ack chips (#14733): the
 * morning/night summary emitted onto the assistant stream must end with a
 * `[CHOICE:checkin-<reportId>]` block. The marker builder itself is pinned by
 * lifeops-choice-markers.test.ts; this suite covers the DISPATCH wiring —
 * deterministic vitest with the check-in engine and sleep-cycle predicates
 * mocked, so only summary+chips → emitAssistantEvent is under test.
 *
 * A second suite pins the connector-delivery slice (#14702): the dispatch
 * consults the owner's ranked contact routes and sends the same summary+chips
 * to the top non-vetoed connected route via `runtime.sendMessageToTarget`
 * BEFORE the guaranteed in-app emit, so connector-primary / headless owners
 * stop losing the night (and sleep-cycle morning) check-in off-app.
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

function makeDomain(
  overrides: { candidates?: unknown[]; sendMessageToTarget?: unknown } = {},
) {
  const emitAssistantEvent = vi.fn();
  const ctx = {
    runtime: {
      emitEvent: vi.fn(async () => undefined),
      ...(overrides.sendMessageToTarget
        ? { sendMessageToTarget: overrides.sendMessageToTarget }
        : {}),
    },
    repository: {
      listChannelPolicies: vi.fn(async () => []),
    },
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
  // TS `private` is compile-time only — stub the contact-route ranking and the
  // activity-profile read so the dispatch path needs no owner-contacts / DB
  // fixture. `resolveOwnerContactRouteCandidates` is the seam the check-in
  // dispatch consults for connected-route delivery (#14702).
  const stubbed = domain as unknown as {
    resolveOwnerContactRouteCandidates: unknown;
    readReminderActivityProfileSnapshot: unknown;
  };
  stubbed.readReminderActivityProfileSnapshot = vi.fn(async () => null);
  stubbed.resolveOwnerContactRouteCandidates = vi.fn(
    async () => overrides.candidates ?? [],
  );
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

describe("sleep-cycle check-in connector delivery (#14702)", () => {
  beforeEach(() => {
    checkinMocks.hasCheckinForLocalDay.mockClear();
    checkinMocks.hasCheckinForLocalDay.mockResolvedValue(false);
    checkinMocks.runMorningCheckin.mockClear();
  });

  it("delivers the summary+chips to the top connected connector route, then still emits in-app", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const { domain, emitAssistantEvent } = makeDomain({
      sendMessageToTarget,
      candidates: [
        {
          channel: "telegram",
          score: 10,
          evidence: ["purpose:checkin"],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
      ],
    });
    // The connector-target resolver + policy lookup are exercised elsewhere;
    // stub them so this suite pins the dispatch decision (top non-vetoed route
    // → sendMessageToTarget with the same ack-marker text) without a DB.
    const stubbed = domain as unknown as {
      resolvePrimaryChannelPolicy: unknown;
      resolveRuntimeReminderTarget: unknown;
    };
    stubbed.resolvePrimaryChannelPolicy = vi.fn(async () => null);
    stubbed.resolveRuntimeReminderTarget = vi.fn(async () => ({
      source: "telegram",
      connectorRef: "runtime:telegram:chat-1",
      target: { source: "telegram", channelId: "chat-1" },
      resolution: { sourceOfTruth: "config" },
    }));

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
    const [target, payload] = sendMessageToTarget.mock.calls[0] as [
      Record<string, unknown>,
      { text: string; source: string; metadata: Record<string, unknown> },
    ];
    expect(target).toMatchObject({ source: "telegram", channelId: "chat-1" });
    // The connector send carries the same owner-facing text (ack chips
    // included) so #14884/#14885 ack round-trips off-app.
    expect(payload.text).toContain(
      "Morning! 2 meetings today, 1 overdue todo.",
    );
    expect(payload.text).toContain("[CHOICE:checkin-rep-morning-1");
    expect(payload.metadata).toMatchObject({
      channelType: "telegram",
      lifeopsCheckin: true,
      checkinReportId: "rep-morning-1",
    });
    // In-app remains the guaranteed final rung.
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: true,
      channel: "telegram",
      delivered: true,
    });
  });

  it("skips vetoed and in_app/sms/voice routes and does not send off-app when none qualify", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const { domain, emitAssistantEvent } = makeDomain({
      sendMessageToTarget,
      candidates: [
        {
          channel: "discord",
          score: 8,
          evidence: [],
          vetoReasons: ["quiet_hours"],
          interruptionBudget: "normal",
        },
        {
          channel: "in_app",
          score: 5,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
        {
          channel: "sms",
          score: 4,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
      ],
    });

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).not.toHaveBeenCalled();
    // The check-in is never dropped: in-app still fires.
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: false,
      channel: null,
      delivered: false,
    });
  });

  it("degrades to in-app only when contact-route resolution throws", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const emitAssistantEvent = vi.fn();
    const ctx = {
      runtime: {
        emitEvent: vi.fn(async () => undefined),
        sendMessageToTarget,
      },
      repository: {
        // The check-in dispatch reads channel policies to rank routes; a
        // throw here must not drop the check-in.
        listChannelPolicies: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
      },
      agentId: () => "00000000-0000-0000-0000-0000000000dd",
      emitAssistantEvent,
      logLifeOpsWarn: vi.fn(),
      logLifeOpsError: vi.fn(),
    };
    const domain = new RemindersDomain(
      ctx as unknown as LifeOpsContext,
      {
        runDueWorkflows: vi.fn(async () => []),
        runDueEventWorkflows: vi.fn(async () => []),
        snoozeOccurrence: vi.fn(),
        checkinSource: {},
      } as unknown as RemindersDeps,
    );
    (
      domain as unknown as { readReminderActivityProfileSnapshot: unknown }
    ).readReminderActivityProfileSnapshot = vi.fn(async () => null);

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).not.toHaveBeenCalled();
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: false,
      delivered: false,
    });
  });

  it("falls back to in-app when the connector send throws", async () => {
    const sendMessageToTarget = vi.fn(async () => {
      throw new Error("connector offline");
    });
    const { domain, emitAssistantEvent } = makeDomain({
      sendMessageToTarget,
      candidates: [
        {
          channel: "telegram",
          score: 10,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
      ],
    });
    const stubbed = domain as unknown as {
      resolvePrimaryChannelPolicy: unknown;
      resolveRuntimeReminderTarget: unknown;
    };
    stubbed.resolvePrimaryChannelPolicy = vi.fn(async () => null);
    stubbed.resolveRuntimeReminderTarget = vi.fn(async () => ({
      source: "telegram",
      connectorRef: "runtime:telegram:chat-1",
      target: { source: "telegram", channelId: "chat-1" },
      resolution: { sourceOfTruth: "config" },
    }));

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: true,
      channel: "telegram",
      delivered: false,
    });
  });

  it("tries the next ranked connector route when the top route send fails", async () => {
    const sendMessageToTarget = vi
      .fn()
      .mockRejectedValueOnce(new Error("telegram offline"))
      .mockResolvedValueOnce(undefined);
    const { domain, emitAssistantEvent } = makeDomain({
      sendMessageToTarget,
      candidates: [
        {
          channel: "telegram",
          score: 10,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
        {
          channel: "discord",
          score: 9,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
      ],
    });
    const stubbed = domain as unknown as {
      resolvePrimaryChannelPolicy: unknown;
      resolveRuntimeReminderTarget: unknown;
    };
    stubbed.resolvePrimaryChannelPolicy = vi.fn(async () => null);
    stubbed.resolveRuntimeReminderTarget = vi.fn(async (channel: string) => ({
      source: channel,
      connectorRef: `runtime:${channel}:chat-1`,
      target: { source: channel, channelId: `${channel}-chat-1` },
      resolution: { sourceOfTruth: "config" },
    }));

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).toHaveBeenCalledTimes(2);
    expect(sendMessageToTarget.mock.calls[0][0]).toMatchObject({
      source: "telegram",
      channelId: "telegram-chat-1",
    });
    expect(sendMessageToTarget.mock.calls[1][0]).toMatchObject({
      source: "discord",
      channelId: "discord-chat-1",
    });
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: true,
      channel: "discord",
      delivered: true,
    });
  });

  it("tries the next ranked connector route when target resolution fails", async () => {
    const sendMessageToTarget = vi.fn(async () => undefined);
    const { domain, emitAssistantEvent } = makeDomain({
      sendMessageToTarget,
      candidates: [
        {
          channel: "telegram",
          score: 10,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
        {
          channel: "discord",
          score: 9,
          evidence: [],
          vetoReasons: [],
          interruptionBudget: "normal",
        },
      ],
    });
    const stubbed = domain as unknown as {
      resolvePrimaryChannelPolicy: unknown;
      resolveRuntimeReminderTarget: unknown;
    };
    stubbed.resolvePrimaryChannelPolicy = vi.fn(async () => null);
    stubbed.resolveRuntimeReminderTarget = vi.fn(async (channel: string) => {
      if (channel === "telegram") {
        throw new Error("telegram route unavailable");
      }
      return {
        source: channel,
        connectorRef: `runtime:${channel}:chat-1`,
        target: { source: channel, channelId: `${channel}-chat-1` },
        resolution: { sourceOfTruth: "config" },
      };
    });

    await runSleepCycleCheckins(domain);

    expect(sendMessageToTarget).toHaveBeenCalledTimes(1);
    expect(sendMessageToTarget.mock.calls[0][0]).toMatchObject({
      source: "discord",
      channelId: "discord-chat-1",
    });
    const [, , data] = emitAssistantEvent.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(data.connectorDelivery).toMatchObject({
      attempted: true,
      channel: "discord",
      delivered: true,
    });
  });
});
