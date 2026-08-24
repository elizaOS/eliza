/**
 * Fire-time `meeting_join` channel handler tests. The calendar row is served
 * through the real `CalendarRepository` SQL path (a stubbed drizzle `execute`
 * returning DB-shaped rows), and every failure mode must come back as a typed
 * `DispatchResult` — never a throw.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  createAnchorRegistry,
  createCompletionCheckRegistry,
  createConsolidationRegistry,
  createEscalationLadderRegistry,
  createInMemoryScheduledTaskLogStore,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  createTaskGateRegistry,
  registerAnchorRegistry,
  registerBuiltInCompletionChecks,
  registerBuiltInGates,
  registerDefaultEscalationLadders,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "@elizaos/plugin-scheduling";
import type {
  LifeOpsCalendarEvent,
  MeetingJoinRequest,
  MeetingSession,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { reconcileMeetingAutoJoin } from "./auto-join.js";
import { writeMeetingAutoJoinPolicy } from "./auto-join-settings.js";
import {
  handleMeetingJoinDispatch,
  MEETING_JOIN_CHANNEL_KEY,
  readMeetingJoinTarget,
} from "./meeting-join-dispatch.js";

const AGENT_ID = "agent-test";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    external_event_id: "ext-1",
    agent_id: AGENT_ID,
    provider: "google",
    side: "owner",
    calendar_id: "primary",
    title: "Design sync",
    description: "",
    location: "",
    status: "confirmed",
    start_at: "2026-07-03T15:00:00.000Z",
    end_at: "2026-07-03T15:30:00.000Z",
    is_all_day: false,
    timezone: "UTC",
    html_link: null,
    conference_link: "https://meet.google.com/abc-defg-hij",
    organizer_json: null,
    attendees_json: "[]",
    metadata_json: "{}",
    synced_at: "2026-07-03T10:00:00.000Z",
    updated_at: "2026-07-03T10:00:00.000Z",
    grant_id: "grant-1",
    connector_account_id: null,
    ...overrides,
  };
}

interface RuntimeOptions {
  rows?: Record<string, unknown>[];
  meetings?: {
    requestJoin: (request: MeetingJoinRequest) => Promise<MeetingSession>;
  } | null;
}

function makeRuntime(options: RuntimeOptions = {}): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: AGENT_ID,
    adapter: {
      db: {
        execute: async () => ({ rows: options.rows ?? [] }),
      },
    },
    getService: (type: string) =>
      type === "meetings" ? (options.meetings ?? null) : null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
}

function session(overrides: Partial<MeetingSession> = {}): MeetingSession {
  return {
    id: "sess-1",
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    nativeMeetingId: "abc-defg-hij",
    botName: "Eliza",
    status: "joining",
    requestedAt: Date.now(),
    participants: [],
    ...overrides,
  };
}

describe("readMeetingJoinTarget", () => {
  it("reads a bare event id and strips the channel prefix", () => {
    expect(readMeetingJoinTarget({ target: "evt-1" })).toBe("evt-1");
    expect(readMeetingJoinTarget({ target: "meeting_join:evt-1" })).toBe(
      "evt-1",
    );
  });
  it("returns null for missing/blank/non-object payloads", () => {
    expect(readMeetingJoinTarget(null)).toBeNull();
    expect(readMeetingJoinTarget({})).toBeNull();
    expect(readMeetingJoinTarget({ target: "  " })).toBeNull();
    expect(readMeetingJoinTarget("evt-1")).toBeNull();
  });
});

const EVENT_NOW = new Date("2026-07-03T10:00:00.000Z");

function lifeOpsEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "evt-1",
    externalId: "ext-1",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Design sync",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-07-03T15:00:00.000Z",
    endAt: "2026-07-03T15:30:00.000Z",
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: "https://meet.google.com/abc-defg-hij",
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: EVENT_NOW.toISOString(),
    updatedAt: EVENT_NOW.toISOString(),
    ...overrides,
  } as LifeOpsCalendarEvent;
}

/**
 * Runtime backed by the REAL `@elizaos/plugin-scheduling` in-memory runner (so
 * the fire-time policy-epoch guard resolves a genuine, reconcile-scheduled task
 * via `runner.get`), plus the calendar SQL stub and a recording meetings
 * service. Used to prove the guard against real tasks rather than a hand-rolled
 * metadata double.
 */
function makeScheduledRuntime(options: RuntimeOptions = {}): {
  runtime: IAgentRuntime;
  runner: ScheduledTaskRunnerHandle;
} {
  const cache = new Map<string, unknown>();
  const anchors = createAnchorRegistry();
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const runner = createScheduledTaskRunner({
    agentId: AGENT_ID,
    store: createInMemoryScheduledTaskStore(),
    logStore: createInMemoryScheduledTaskLogStore(),
    gates,
    completionChecks,
    ladders,
    anchors,
    consolidation: createConsolidationRegistry(),
    ownerFacts: () => ({ timezone: "UTC" }),
    globalPause: { current: async () => ({ active: false }) },
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    channelKeys: () => new Set(["in_app", MEETING_JOIN_CHANNEL_KEY]),
    now: () => EVENT_NOW,
  });
  const runnerService = { getRunner: () => runner };
  const runtime = {
    agentId: AGENT_ID,
    adapter: {
      db: { execute: async () => ({ rows: options.rows ?? [] }) },
    },
    getService: (type: string) =>
      type === "meetings"
        ? (options.meetings ?? null)
        : type === "lifeops_scheduled_task_runner"
          ? runnerService
          : null,
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
  registerAnchorRegistry(runtime, anchors);
  return { runtime, runner };
}

async function scheduleJoinTaskId(
  runtime: IAgentRuntime,
  runner: ScheduledTaskRunnerHandle,
): Promise<string> {
  await reconcileMeetingAutoJoin({
    runtime,
    agentId: AGENT_ID,
    events: [lifeOpsEvent()],
    now: () => EVENT_NOW,
  });
  const tasks = await runner.list();
  const join = tasks.find(
    (t) => t.metadata?.calendarAutoJoin === true && t.metadata?.role === "join",
  );
  if (!join) throw new Error("expected a scheduled auto-join join task");
  return join.taskId;
}

describe("handleMeetingJoinDispatch policy-epoch guard", () => {
  it("refuses a stale direct all join once the policy changed to ask (no join without approval) (#26503)", async () => {
    const requests: MeetingJoinRequest[] = [];
    const { runtime, runner } = makeScheduledRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async (request) => {
          requests.push(request);
          return session();
        },
      },
    });
    // Policy `all` scheduled a direct join; then the owner switched to `ask`
    // and the stale direct join lingers into the race window before the next
    // reconcile retires it.
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const taskId = await scheduleJoinTaskId(runtime, runner);
    await writeMeetingAutoJoinPolicy(runtime, "ask");

    const result = await handleMeetingJoinDispatch(runtime, {
      target: `${MEETING_JOIN_CHANNEL_KEY}:evt-1`,
      message: "Join the meeting",
      metadata: { taskId, firedAtIso: "2026-07-03T14:59:00.000Z" },
    });

    expect(result).toMatchObject({ ok: false, reason: "disconnected" });
    // The agent must NOT have joined the meeting the owner never approved.
    expect(requests).toEqual([]);
  });

  it("allows a join whose scheduled mode still matches the current policy (#26503)", async () => {
    const requests: MeetingJoinRequest[] = [];
    const { runtime, runner } = makeScheduledRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async (request) => {
          requests.push(request);
          return session();
        },
      },
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const taskId = await scheduleJoinTaskId(runtime, runner);

    const result = await handleMeetingJoinDispatch(runtime, {
      target: `${MEETING_JOIN_CHANNEL_KEY}:evt-1`,
      message: "Join the meeting",
      metadata: { taskId, firedAtIso: "2026-07-03T14:59:00.000Z" },
    });

    expect(result).toEqual({ ok: true, messageId: "meeting:sess-1" });
    expect(requests).toHaveLength(1);
  });
});

describe("handleMeetingJoinDispatch", () => {
  it("joins the meeting and returns ok with the session id", async () => {
    const requests: MeetingJoinRequest[] = [];
    const runtime = makeRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async (request) => {
          requests.push(request);
          return session();
        },
      },
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
      message: "Join the meeting",
      metadata: { taskId: "st_1", firedAtIso: "2026-07-03T14:59:00.000Z" },
    });
    expect(result).toEqual({ ok: true, messageId: "meeting:sess-1" });
    expect(requests).toEqual([
      {
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        calendarEventId: "evt-1",
      },
    ]);
  });

  it("fails typed when the payload has no target", async () => {
    const runtime = makeRuntime();
    const result = await handleMeetingJoinDispatch(runtime, { message: "x" });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed when the policy was flipped off after scheduling", async () => {
    const runtime = makeRuntime({ rows: [eventRow()] });
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
  });

  it("fails typed when the event no longer exists", async () => {
    const runtime = makeRuntime({ rows: [] });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-gone",
    });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed when the stored link is no longer recognizable", async () => {
    const runtime = makeRuntime({
      rows: [eventRow({ conference_link: "https://example.com/whatever" })],
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({ ok: false, reason: "unknown_recipient" });
  });

  it("fails typed (user-actionable) when the meetings service is missing", async () => {
    const runtime = makeRuntime({ rows: [eventRow()], meetings: null });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
  });

  it("maps a requestJoin failure to transport_error, never a throw", async () => {
    const runtime = makeRuntime({
      rows: [eventRow()],
      meetings: {
        requestJoin: async () => {
          throw new Error("browser bot crashed");
        },
      },
    });
    await writeMeetingAutoJoinPolicy(runtime, "all");
    const result = await handleMeetingJoinDispatch(runtime, {
      target: "evt-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "transport_error",
      message: "browser bot crashed",
    });
  });
});
