import { randomUUID } from "node:crypto";
/**
 * Drives the registered CALENDAR action through the canonical executor over
 * real PGlite calendar, task, and approval stores. Only the remote ICS and
 * secret-vault boundaries are in-memory; every asserted receipt is read back
 * from the same persisted snapshot or row the action consumed.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { LifeOpsConnectorGrant } from "@elizaos/contracts";
import { parseClientTurnObservation } from "@elizaos/contracts/client-turn-observation";
import { readChatRequestPayload } from "../../../packages/agent/src/api/chat-routes.ts";
import { ElizaClient } from "../../../packages/ui/src/api/client-base.ts";
import "../../../packages/ui/src/api/client-chat.ts";
import {
  type ActionResult,
  type AgentRuntime,
  ChannelType,
  type Content,
  conversationClientUserMemoryId,
  executePlannedToolCall,
  isObjectRecord,
  type Memory,
  ModelType,
  promoteSubactionsToActions,
  type UUID,
} from "@elizaos/core";
import { SECRETS_SERVICE_TYPE } from "@elizaos/plugin-assistant";
import {
  type CalendarHostGate,
  CalendarRepository,
  CalendarService,
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "@elizaos/plugin-calendar";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PgApprovalQueue } from "../../plugin-assistant/src/services/approval/store.ts";
import { CALENDAR_AGENDA_CAPABILITY } from "../../plugin-assistant/src/services/device-actions/calendar-contract.ts";
import {
  currentAppRecordSource,
  DeviceActionService,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
  withDeviceActionTurn,
} from "../../plugin-assistant/src/services/device-actions/service.ts";
import { projectClientObservation } from "../../plugin-assistant/src/services/message/client-observation-context.ts";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../src/actions/calendar.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
import { googleHandoffFixture } from "./helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const SOURCE_URL = "https://calendar.example.test/private/receipt-suite.ics";
const SOURCE_SYNCED_AT = new Date().toISOString();
const EVENT_START = "2026-07-29T17:00:00.000Z";
const EVENT_END = "2026-07-29T18:00:00.000Z";
const WINDOW_START = "2026-07-28T00:00:00.000Z";
const WINDOW_END = "2026-08-05T00:00:00.000Z";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let calendar: CalendarService;

function writableGrant(agentId: string): LifeOpsConnectorGrant {
  return {
    id: "connector-account:calendar-receipt-owner",
    agentId,
    provider: "google",
    connectorAccountId: "calendar-receipt-owner",
    side: "owner",
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: ["https://www.googleapis.com/auth/calendar.events"],
    capabilities: ["google.calendar.read", "google.calendar.write"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: SOURCE_SYNCED_AT,
    createdAt: SOURCE_SYNCED_AT,
    updatedAt: SOURCE_SYNCED_AT,
  };
}

function gate(agentId: string): CalendarHostGate {
  const grant = writableGrant(agentId);
  return {
    getGoogleConnectorAccounts: async () => [],
    resolveGuestAvailabilityGrants: async () => [],
    requireGoogleCalendarGrant: async () => grant,
    requireGoogleCalendarWriteGrant: async () => grant,
    createReminderPlan: async () => {},
    updateReminderPlan: async () => {},
    deleteReminderPlan: async () => {},
    listReminderPlansForOwners: async () => [],
    createAuditEvent: async () => {},
  };
}

function icsBody(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//elizaOS//calendar receipt suite//EN",
    "BEGIN:VEVENT",
    "UID:school-planning-receipt-suite",
    "SEQUENCE:1",
    "LAST-MODIFIED:20260727T180000Z",
    "DTSTAMP:20260727T180000Z",
    "DTSTART:20260729T170000Z",
    "DTEND:20260729T180000Z",
    "SUMMARY:School planning meeting",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

function message(id: string, text: string): Memory {
  return {
    id: id as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: "00000000-0000-0000-0000-000000009901" as UUID,
    createdAt: Date.parse("2026-07-27T17:55:00.000Z"),
    content: { source: "test", text },
  } as Memory;
}

async function invoke(
  actor: Memory,
  params: Record<string, unknown>,
  directReply = true,
  actionName = calendarAction.name,
  replyOwner?: "planner",
): Promise<{ delivered: Content[]; result: ActionResult }> {
  const delivered: Content[] = [];
  const result = await executePlannedToolCall(
    runtime,
    {
      message: actor,
      replyOwner,
      userRoles: ["OWNER"],
      activeContexts: ["calendar"],
      callback: async (content) => {
        delivered.push(content);
        return [];
      },
    },
    { name: actionName, params },
    {
      actions: promoteSubactionsToActions(
        calendarAction,
        calendarActionPromotionOptions,
      ).filter((action) => action.name === actionName),
    },
  );
  if (directReply) {
    expect(delivered, JSON.stringify(result)).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      text: result.userFacingText,
      effectReceiptIds: [result.effectReceipts?.[0]?.receiptId],
    });
    expect(result.verifiedUserFacing).toBe(true);
  } else {
    expect(delivered).toEqual([]);
    expect(result.transcriptVisibility, JSON.stringify(result)).toBe(
      "internal",
    );
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
  }
  expect(result.effectReceipts).toHaveLength(1);
  return { delivered, result };
}

const icsTransport = {
  fetchImpl: async () =>
    new Response(icsBody(), {
      status: 200,
      headers: {
        "content-type": "text/calendar",
        etag: '"receipt-suite-v1"',
      },
    }),
};

beforeEach(() => {
  // A case may select a connected account; later cases keep the default owner gate.
  calendar.setGate(gate(String(runtime.agentId)));
  const sync = calendar.syncIcsCalendarSource.bind(calendar);
  // Every forced refresh crosses the same remote fixture boundary; the real
  // synchronizer still validates, parses and persists the subscription.
  vi.spyOn(calendar, "syncIcsCalendarSource").mockImplementation(
    (sourceId, options = {}) =>
      sync(sourceId, { ...options, transport: icsTransport }),
  );
});

afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  const secretValues = new Map<string, string>();
  const secretService = {
    serviceType: SECRETS_SERVICE_TYPE,
    capabilityDescription: "In-memory secret boundary for ICS integration",
    getGlobal: async (key: string) => secretValues.get(key) ?? null,
    setGlobal: async (key: string, value: string) => {
      secretValues.set(key, value);
      return true;
    },
    delete: async (key: string) => secretValues.delete(key),
    stop: async () => {},
  };
  const services = (runtime as unknown as { services: Map<string, unknown[]> })
    .services;
  services.set(SECRETS_SERVICE_TYPE, [secretService]);
  const resolved = runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!resolved) throw new Error("calendar service was not registered");
  calendar = resolved;
  calendar.setGate(gate(String(runtime.agentId)));
  const source = await calendar.createIcsCalendarSource({
    name: "Receipt suite",
    url: SOURCE_URL,
  });
  await calendar.syncIcsCalendarSource(source.id, {
    now: new Date(SOURCE_SYNCED_AT),
    transport: icsTransport,
  });
}, 180_000);

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("registered CALENDAR strict settlement — real PGlite", () => {
  it("publishes a concrete nested schema and composes the real ACTIONS provider", async () => {
    const registered = runtime.actions.find(
      (action) => action.name === calendarAction.name,
    );
    expect(registered).toBeDefined();
    const details = registered?.parameters?.find(
      (parameter) => parameter.name === "details",
    );
    expect(details?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        start: { type: "string" },
        recurrence: expect.any(Object),
      },
    });

    const state = await runtime.composeState(
      message("00000000-0000-0000-0000-000000009900", "Show my calendar."),
      ["ACTIONS"],
      true,
      true,
    );
    expect(state.text).toContain(calendarAction.name);
    expect(state.text).toMatch(/(?:default.{0,40}60|60.{0,40}default)/i);
    const createChild = promoteSubactionsToActions(
      calendarAction,
      calendarActionPromotionOptions,
    ).find((action) => action.name === "CALENDAR_CREATE_EVENT");
    expect(createChild?.description).toMatch(/60-minute timed default/);
    const childDetails = createChild?.parameters?.find(
      (parameter) => parameter.name === "details",
    );
    expect(childDetails?.required).toBe(false);
    expect(childDetails?.descriptionCompressed).toMatch(/domain default 60m/);
  });

  it("returns a settled observation for planner-owned availability reads", async () => {
    const collaborator = await import("@elizaos/plugin-assistant");
    const { renderGroundedActionReply } = await import(
      "../../plugin-assistant/src/actions/grounded-action-reply.ts"
    );
    vi.spyOn(collaborator, "renderGroundedActionReply").mockImplementation(
      renderGroundedActionReply,
    );
    const actor = message(
      "00000000-0000-0000-0000-000000009978",
      "Check this window before moving the event.",
    );
    const { result } = await invoke(
      actor,
      { action: "check_availability", startAt: EVENT_START, endAt: EVENT_END },
      false,
      calendarAction.name,
      "planner",
    );
    expect(result.success).toBe(true);
    expect(result.data?.readOnlyOperation).toBe(true);
    expect(result.turnComplete).toBeUndefined();
    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      operation: "calendar.check_availability.read",
      idempotency: { replayed: false },
    });
  });

  it.each([undefined, "2026-07-29T17:05:00.000Z"])(
    "checks the full requested duration including a conflict in its final five minutes (end %s)",
    async (endAt) => {
      const actor = message(
        "00000000-0000-0000-0000-000000009976",
        "Am I free at 16:50 UTC for 15 minutes?",
      );
      const { result } = await invoke(
        actor,
        {
          interval: {
            startAt: "2026-07-29T16:50:00.000Z",
            durationMinutes: 15,
            ...(endAt === undefined ? {} : { endAt }),
          },
        },
        true,
        "CALENDAR_CHECK_AVAILABILITY",
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        isFree: false,
        windowStart: "2026-07-29T16:50:00.000Z",
        windowEnd: "2026-07-29T17:05:00.000Z",
        conflicts: [
          expect.objectContaining({ title: "School planning meeting" }),
        ],
      });
    },
  );

  it.each([
    { durationMinutes: 0 },
    { durationMinutes: -15 },
    { durationMinutes: Number.POSITIVE_INFINITY },
    { durationMinutes: Number.NaN },
    { durationMinutes: "15" },
    { endAt: null },
    {},
    { durationMinutes: 15, endAt: "2026-07-29T17:00:00.000Z" },
    { durationMinutes: 15, endAt: "not a time" },
  ])(
    "rejects an invalid or contradictory availability range %j",
    async (range) => {
      const actor = message(
        "00000000-0000-0000-0000-000000009975",
        "Check 16:50 UTC for 15 minutes.",
      );
      const result = await executePlannedToolCall(
        runtime,
        {
          message: actor,
          replyOwner: "planner",
          userRoles: ["OWNER"],
          activeContexts: ["calendar"],
        },
        {
          name: "CALENDAR_CHECK_AVAILABILITY",
          params: {
            interval: { startAt: "2026-07-29T16:50:00.000Z", ...range },
          },
        },
        {
          actions: promoteSubactionsToActions(
            calendarAction,
            calendarActionPromotionOptions,
          ).filter((action) => action.name === "CALENDAR_CHECK_AVAILABILITY"),
        },
      );
      expect(result.success).toBe(false);
      expect(result.data?.isFree).toBeUndefined();
      expect(
        result.effectReceipts?.some((receipt) => receipt.outcome === "noop"),
      ).not.toBe(true);
    },
  );

  it.each([
    // Fractional local forms still reject a clock skipped by DST.
    {
      windowStart: "2027-03-14T02:30:00.250",
      windowEnd: "2027-03-14T12:00:00.250",
    },
    { windowStart: "2027-02-30T09:00:00", windowEnd: "2027-03-01T12:00:00" },
    { windowStart: "2027-03-14T02:30:00", windowEnd: "2027-03-14T12:00:00" },
    {
      windowStart: "2027-01-18T09:00:00−05:00",
      windowEnd: "2027-01-18T12:00:00-05:00",
    },
    { windowStart: "2027-01-18T09:00:00-05:00", windowEnd: "not a date" },
    {
      windowStart: "2027-01-18T12:00:00-05:00",
      windowEnd: "2027-01-18T09:00:00-05:00",
    },
    {
      windowStart: "2027-01-18T09:00:00-05:00",
      windowEnd: "2027-01-18T09:00:00-05:00",
    },
  ])(
    "rejects an invalid supplied proposal window before reading the calendar: %j",
    async (window) => {
      const read = vi.spyOn(calendar, "getCalendarFeed");
      const { result } = await invoke(
        message(
          "00000000-0000-0000-0000-000000009980",
          "Offer January 18 morning slots.",
        ),
        { ...window, timeZone: "America/New_York", duration: { minutes: 15 } },
        true,
        "CALENDAR_PROPOSE_TIMES",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("INVALID_WINDOW");
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "failed",
        failure: { acceptance: "rejected" },
      });
      expect(result.data?.slots).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("exposes missing interval inputs as a repairable call error, not a calendar finding", async () => {
    const result = await executePlannedToolCall(
      runtime,
      {
        message: message(
          "00000000-0000-0000-0000-000000009974",
          "Check 16:50 UTC for 15 minutes.",
        ),
        replyOwner: "planner",
        userRoles: ["OWNER"],
        activeContexts: ["calendar"],
      },
      {
        name: "CALENDAR",
        params: {
          action: "check_availability",
          startAt: "2026-07-29T16:50:00.000Z",
        },
      },
      {
        actions: promoteSubactionsToActions(
          calendarAction,
          calendarActionPromotionOptions,
        ).filter((action) => action.name === "CALENDAR"),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("INVALID_WINDOW");
    expect(result.error).toContain("durationMinutes or endAt");
    expect(result.error).toContain("No calendar read was performed");
    expect(result.data?.isFree).toBeUndefined();
    expect(result.effectReceipts?.[0]).toMatchObject({
      outcome: "failed",
      failure: { acceptance: "rejected" },
    });
  });

  it("gives distinct same-turn availability reads distinct receipt identities", async () => {
    const actor = message(
      "00000000-0000-0000-0000-000000009977",
      "Check two windows.",
    );
    const first = await invoke(actor, {
      action: "check_availability",
      startAt: EVENT_START,
      endAt: EVENT_END,
    });
    const second = await invoke(actor, {
      action: "check_availability",
      startAt: WINDOW_START,
      endAt: WINDOW_END,
    });
    expect(first.result.success).toBe(true);
    expect(second.result.success).toBe(true);
    expect(first.result.effectReceipts?.[0]?.receiptId).not.toBe(
      second.result.effectReceipts?.[0]?.receiptId,
    );
  });

  it.each([
    {
      name: "delegated feed",
      params: {
        action: "feed",
        details: { timeMin: WINDOW_START, timeMax: WINDOW_END },
      },
      outcome: "noop",
      operation: "calendar.feed.read",
      directReply: false,
    },
    {
      name: "bulk preview",
      params: { action: "bulk_reschedule" },
      outcome: "preview",
      operation: "calendar.bulk_reschedule.preview",
      directReply: true,
    },
    {
      name: "availability read",
      params: {
        action: "check_availability",
        startAt: EVENT_START,
        endAt: EVENT_END,
      },
      outcome: "noop",
      operation: "calendar.check_availability.read",
      directReply: true,
    },
    {
      name: "slot preview",
      params: {
        action: "propose_times",
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        slotCount: 2,
      },
      outcome: "preview",
      operation: "calendar.propose_times.preview",
      directReply: true,
    },
  ])("binds $name to its observed calendar snapshot", async (testCase) => {
    const readStarted = Date.now();
    const { result } = await invoke(
      message(
        `00000000-0000-0000-0000-${testCase.operation
          .split("")
          .reduce((sum, character) => sum + character.charCodeAt(0), 0)
          .toString()
          .padStart(12, "0")}`,
        testCase.name === "bulk preview"
          ? "Push all school meetings later."
          : `Run ${testCase.name}.`,
      ),
      testCase.params,
      testCase.directReply,
    );
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: testCase.operation,
      outcome: testCase.outcome,
      resource: {
        kind: "calendar.feed",
        id: expect.any(String),
        version: expect.stringMatching(/(?:^|:)[a-f0-9]{64}$/),
      },
      observedAt: expect.any(String),
    });
    const observed = Date.parse(result.effectReceipts?.[0]?.observedAt ?? "");
    expect(observed).toBeGreaterThanOrEqual(readStarted);
    expect(observed).toBeLessThanOrEqual(Date.now());
  });

  it("scopes the bulk reschedule cohort to the owner's calendar day and month", async () => {
    // 01:00 on 1 August in Tokyo; still 31 July in UTC and every zone west
    // of it, so a host-zone window differs on both bounds.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-31T16:00:00.000Z"));
    const store = resolveOwnerFactStore(runtime);
    const feed = vi.spyOn(calendar, "getCalendarFeed");
    const text = "Push all school meetings before next month.";
    try {
      await store.update(
        { timezone: "Asia/Tokyo" },
        { source: "profile_save", recordedAt: "2026-07-27T17:54:00.000Z" },
      );
      await invoke(message("00000000-0000-0000-0000-000000009961", text), {
        action: "bulk_reschedule",
      });
      expect(feed).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          timeMin: "2026-07-31T15:00:00.000Z",
          timeMax: "2026-08-31T15:00:00.000Z",
          timeZone: "Asia/Tokyo",
        }),
      );

      await invoke(message("00000000-0000-0000-0000-000000009962", text), {
        action: "bulk_reschedule",
        timeZone: "America/New_York",
      });
      expect(feed).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          timeMin: "2026-07-31T04:00:00.000Z",
          timeMax: "2026-08-01T04:00:00.000Z",
          timeZone: "America/New_York",
        }),
      );

      // An unreadable owner zone fails the preview; no calendar read is made
      // in a substituted zone.
      feed.mockClear();
      vi.spyOn(runtime, "getCache").mockRejectedValue(
        new Error("owner fact cache unavailable"),
      );
      const failed = await executePlannedToolCall(
        runtime,
        {
          message: message("00000000-0000-0000-0000-000000009963", text),
          userRoles: ["OWNER"],
          activeContexts: ["calendar"],
          callback: async () => [],
        },
        { name: calendarAction.name, params: { action: "bulk_reschedule" } },
        {
          actions: promoteSubactionsToActions(
            calendarAction,
            calendarActionPromotionOptions,
          ).filter((action) => action.name === calendarAction.name),
        },
      );
      expect(failed.success).toBe(false);
      expect(JSON.stringify(failed)).toContain(
        "CALENDAR_TIME_ZONE_UNAVAILABLE",
      );
      expect(feed).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await store.clear();
      vi.useRealTimers();
    }
  });

  it("distinguishes an elapsed daily feed from tomorrow's next event at evening time", async () => {
    const now = "2028-09-25T03:53:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
    try {
      for (const [title, startAt, endAt] of [
        [
          "Elapsed afternoon event",
          "2028-09-24T23:30:00.000Z",
          "2028-09-24T23:45:00.000Z",
        ],
        [
          "Tomorrow upcoming event",
          "2028-09-25T18:00:00.000Z",
          "2028-09-25T18:15:00.000Z",
        ],
      ]) {
        await calendar.createCalendarEventMutation(
          new URL("http://internal.local"),
          {
            title,
            startAt,
            endAt,
            timeZone: "America/Los_Angeles",
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            idempotencyKey: title,
          },
        );
      }
      const actor = message(
        "00000000-0000-0000-0000-000000009953",
        "Read my next saved calendar event. Do not change anything.",
      );
      const details = {
        calendarId: ELIZA_CALENDAR_ID,
        timeZone: "America/Los_Angeles",
      };
      const feed = (
        await invoke(
          actor,
          { intent: "next event", details },
          false,
          "CALENDAR_FEED",
        )
      ).result;
      expect(feed.success).toBe(true);
      expect(feed.data?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Elapsed afternoon event" }),
        ]),
      );
      expect(feed.data?.events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Tomorrow upcoming event" }),
        ]),
      );
      expect(feed.data?.replyContext).toMatchObject({
        scenario: "feed_results",
        context: {
          asOf: now,
          selection: "bounded_agenda",
          nextEventLookupPerformed: false,
        },
      });
      expect(JSON.stringify(feed.data?.replyContext)).toContain(
        "CALENDAR_NEXT_EVENT",
      );
      const next = (
        await invoke(actor, { details }, false, "CALENDAR_NEXT_EVENT")
      ).result;
      expect(next.success).toBe(true);
      expect(next.data?.event).toMatchObject({
        title: "Tomorrow upcoming event",
        startAt: "2028-09-25T18:00:00.000Z",
      });
      expect(next.effectReceipts?.[0]?.operation).not.toBe(
        "calendar.feed.read",
      );
      expect(next.transcriptVisibility).toBe("internal");
      expect(next).not.toHaveProperty("userFacingText");
      expect(next).not.toHaveProperty("verifiedUserFacing");
      expect(next).not.toHaveProperty("userFacingEffectReceiptIds");
      expect(next.data?.replyContext).toMatchObject({
        scenario: "next_event",
        userFacingFacts: expect.stringContaining("Tomorrow upcoming event"),
      });
      expect(JSON.stringify(next.data?.replyContext)).not.toContain(
        "Elapsed afternoon event",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["CALENDAR_FEED", "CALENDAR_SEARCH_EVENTS"])(
    "executes %s with aliased read bounds through the promoted child",
    async (actionName) => {
      const { result } = await invoke(
        message(
          actionName === "CALENDAR_FEED"
            ? "00000000-0000-0000-0000-000000009951"
            : "00000000-0000-0000-0000-000000009952",
          "Read the school planning meeting in the specified window. Do not change it.",
        ),
        {
          ...(actionName === "CALENDAR_SEARCH_EVENTS"
            ? { query: "School planning meeting" }
            : {}),
          details: {
            time_min: WINDOW_START,
            time_max: WINDOW_END,
            time_zone: "UTC",
            includeHiddenCalendars: true,
            force_sync: false,
          },
        },
        false,
        actionName,
      );
      expect(result.success).toBe(true);
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "noop",
        resource: { kind: "calendar.feed" },
      });
      expect(JSON.stringify(result.data)).toContain("School planning meeting");
      expect(JSON.stringify(result.data)).toContain(EVENT_START);
    },
  );

  it("interprets fractional local proposal bounds in the requested timezone", async () => {
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009987",
        "Find a one-hour opening in this window.",
      ),
      {
        duration: { minutes: 60 },
        windowStart: "2027-01-18T09:00:00.250",
        windowEnd: "2027-01-18T12:00:00.250",
        timeZone: "America/New_York",
      },
      true,
      "CALENDAR_PROPOSE_TIMES",
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      windowStart: "2027-01-18T14:00:00.250Z",
      windowEnd: "2027-01-18T17:00:00.250Z",
    });
  });

  it.each([undefined, "planner"] as const)(
    "proposes a new window and awaits selection without changing the event (reply owner %s)",
    async (replyOwner) => {
      if (replyOwner === "planner") {
        // Exercise the real deferred renderer; the package's default collaborator
        // always returns a standalone model reply and cannot represent this path.
        const collaborator = await import("@elizaos/plugin-assistant");
        const { renderGroundedActionReply } = await import(
          "../../plugin-assistant/src/actions/grounded-action-reply.ts"
        );
        vi.spyOn(collaborator, "renderGroundedActionReply").mockImplementation(
          renderGroundedActionReply,
        );
      }
      const { result } = await invoke(
        message(
          replyOwner === "planner"
            ? "00000000-0000-0000-0000-000000009979"
            : "00000000-0000-0000-0000-000000009971",
          'Check which times are free January 18, 2027 in the morning for moving "School planning meeting". Do not move it yet.',
        ),
        {
          duration: { existingEventQuery: "School planning meeting" },
          windowStart: "2027-01-18T09:00:00",
          windowEnd: "2027-01-18T12:00:00",
          timeZone: "America/New_York",
        },
        replyOwner !== "planner",
        "CALENDAR_PROPOSE_TIMES",
        replyOwner,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        awaitingUserInput: true,
        windowStart: "2027-01-18T14:00:00.000Z",
        windowEnd: "2027-01-18T17:00:00.000Z",
        durationMinutes: 60,
        existingEvent: {
          title: "School planning meeting",
          startAt: EVENT_START,
          endAt: EVENT_END,
        },
        existingEventDisplay: {
          localStart: expect.stringMatching(/^Wed, Jul 29(?: at |, )1:00 PM$/),
          localEnd: expect.stringMatching(/^Wed, Jul 29(?: at |, )2:00 PM$/),
          timeZone: "America/New_York",
        },
        slots: expect.arrayContaining([
          expect.objectContaining({ durationMinutes: 60 }),
        ]),
        targetSnapshot: expect.any(Object),
      });
      const feed = await calendar.getCalendarFeed(
        new URL("http://internal.local"),
        {
          timeMin: WINDOW_START,
          timeMax: WINDOW_END,
          includeHiddenCalendars: true,
        },
      );
      expect(
        feed.events.filter(
          (event) => event.title === "School planning meeting",
        ),
      ).toEqual([
        expect.objectContaining({ startAt: EVENT_START, endAt: EVENT_END }),
      ]);
    },
  );

  it.each([undefined, "planner"] as const)(
    "awaits a new booking selection without creating an event (reply owner %s)",
    async (replyOwner) => {
      if (replyOwner === "planner") {
        const collaborator = await import("@elizaos/plugin-assistant");
        const { renderGroundedActionReply } = await import(
          "../../plugin-assistant/src/actions/grounded-action-reply.ts"
        );
        vi.spyOn(collaborator, "renderGroundedActionReply").mockImplementation(
          renderGroundedActionReply,
        );
      }
      const bounds = {
        timeMin: "2027-01-18T14:00:00.000Z",
        timeMax: "2027-01-18T17:00:00.000Z",
        includeHiddenCalendars: true,
      };
      const before = await calendar.getCalendarFeed(
        new URL("http://internal.local"),
        bounds,
      );
      const { result } = await invoke(
        message(
          replyOwner === "planner"
            ? "00000000-0000-0000-0000-000000009981"
            : "00000000-0000-0000-0000-000000009982",
          replyOwner === "planner"
            ? "Schedule a 15-minute planning meeting with Mira and Rowan January 18 in the morning, in America/New_York."
            : "Schedule a 15-minute planning meeting January 18 in the morning, in America/New_York.",
        ),
        {
          duration: { minutes: 15 },
          ...(replyOwner === "planner"
            ? { counterparties: ["Mira", "Rowan"] }
            : {}),
          windowStart: "2027-01-18T09:00:00",
          windowEnd: "2027-01-18T12:00:00",
          timeZone: "America/New_York",
        },
        replyOwner !== "planner",
        "CALENDAR_PROPOSE_TIMES",
        replyOwner,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        awaitingUserInput: true,
        counterparties: replyOwner === "planner" ? ["Mira", "Rowan"] : [],
        durationMinutes: 15,
        slots: expect.arrayContaining([
          expect.objectContaining({ durationMinutes: 15 }),
        ]),
      });
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "preview",
        operation: "calendar.propose_times.preview",
      });
      if (replyOwner === "planner") {
        expect(result.transcriptVisibility, JSON.stringify(result)).toBe(
          "internal",
        );
        expect(result.data?.replyGrounding).toEqual(expect.any(String));
      }
      const after = await calendar.getCalendarFeed(
        new URL("http://internal.local"),
        bounds,
      );
      expect(after.events).toEqual(before.events);
    },
  );

  it("does not substitute a default duration for an unresolved existing event", async () => {
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009970",
        "Move the nonexistent rehearsal to tomorrow morning.",
      ),
      {
        duration: { existingEventQuery: "nonexistent rehearsal" },
        windowStart: "2027-01-18T09:00:00Z",
        windowEnd: "2027-01-18T12:00:00Z",
        timeZone: "UTC",
      },
      true,
      "CALENDAR_PROPOSE_TIMES",
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      awaitingUserInput: true,
      candidates: [],
    });
    expect(result.data).not.toHaveProperty("slots");
  });

  it("asks which existing event before proposing slots for duplicate titles", async () => {
    for (const hour of [14, 16]) {
      await calendar.createCalendarEventMutation(
        new URL("http://internal.local"),
        {
          title: "Duplicate proposal target",
          startAt: `2027-01-18T${hour}:00:00Z`,
          endAt: `2027-01-18T${hour}:30:00Z`,
          timeZone: "UTC",
          grantId: ELIZA_CALENDAR_GRANT_ID,
          calendarId: ELIZA_CALENDAR_ID,
          idempotencyKey: `duplicate-proposal-target-${hour}`,
        },
      );
    }
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009969",
        "Move Duplicate proposal target to the morning.",
      ),
      {
        duration: { existingEventQuery: "Duplicate proposal target" },
        windowStart: "2027-01-18T09:00:00Z",
        windowEnd: "2027-01-18T12:00:00Z",
        timeZone: "UTC",
      },
      true,
      "CALENDAR_PROPOSE_TIMES",
    );
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ awaitingUserInput: true });
    expect(result.data?.candidates).toHaveLength(2);
    expect(result.data).not.toHaveProperty("slots");
  });

  it("persists meeting preferences and binds the receipt to the read-back task", async () => {
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009911",
        "Keep meetings between ten and four.",
      ),
      {
        action: "update_preferences",
        timeZone: "UTC",
        preferredStartLocal: "10:00",
        preferredEndLocal: "16:00",
        travelBufferMinutes: 15,
      },
    );
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "calendar.meeting_preferences.update",
      outcome: "applied",
      resource: {
        kind: "lifeops.scheduled_task",
        id: expect.any(String),
        version: expect.any(String),
      },
      commit: {
        kind: "durable",
        id: expect.any(String),
        committedAt: expect.any(String),
      },
    });
  });

  it("settles policy blocks, clarifications, and invalid reads as non-applied", async () => {
    await resolveOwnerFactStore(runtime).update(
      {
        timezone: "UTC",
        quietHours: {
          startLocal: "16:00",
          endLocal: "19:00",
          timezone: "UTC",
        },
      },
      {
        source: "profile_save",
        recordedAt: "2026-07-27T17:54:00.000Z",
      },
    );
    const protectedResult = (
      await invoke(
        message(
          "00000000-0000-0000-0000-000000009921",
          "Book a team sync at 5pm.",
        ),
        {
          action: "create_event",
          title: "Team sync",
          details: { start: EVENT_START, end: EVENT_END },
        },
      )
    ).result;
    expect(protectedResult.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      operation: "calendar.create_event",
    });
    await resolveOwnerFactStore(runtime).clear();

    const invalid = (
      await invoke(
        message(
          "00000000-0000-0000-0000-000000009923",
          "Am I free in this invalid window?",
        ),
        {
          action: "check_availability",
          startAt: EVENT_END,
          endAt: EVENT_START,
        },
      )
    ).result;
    expect(invalid.effectReceipts?.[0]).toMatchObject({
      outcome: "failed",
      failure: { code: "INVALID_WINDOW", acceptance: "rejected" },
    });
  });

  it.each([
    {
      id: "00000000-0000-0000-0000-000000009978",
      requiresInput: false,
      startAt: null,
      missingAuthority: false,
    },
    {
      id: "00000000-0000-0000-0000-000000009977",
      requiresInput: true,
      startAt: "2026-07-30T10:00:00Z",
      missingAuthority: false,
    },
    {
      id: "00000000-0000-0000-0000-000000009976",
      requiresInput: false,
      startAt: "2026-07-30T10:00:00Z",
      missingAuthority: true,
    },
  ])(
    "blocks preset-only or clarification-required creation ($requiresInput, missingAuthority=$missingAuthority)",
    async ({ id, requiresInput, startAt, missingAuthority }) => {
      const original =
        "Create an event called Create extraction timing check on July 30, 2026 in the morning for 15 minutes.";
      const evidence = [{ sourceId: `current:${id}`, quote: original }];
      const useModel = runtime.useModel.bind(runtime);
      let extractionCalls = 0;
      vi.spyOn(runtime, "useModel").mockImplementation((async (
        type,
        params,
      ) => {
        if (
          type === ModelType.TEXT_LARGE &&
          String(params?.prompt).includes(
            "Extract calendar event creation fields",
          )
        ) {
          extractionCalls += 1;
          expect(params).toMatchObject({
            temperature: 0,
            responseSchema: {
              type: "object",
              additionalProperties: false,
              required: expect.arrayContaining([
                "title",
                "startAt",
                "endAt",
                "durationMinutes",
                "requiresInput",
                "guestIntent",
                "noteIntent",
                "grantId",
                "calendarId",
              ]),
              properties: { startAt: { type: ["string", "null"] } },
            },
          });
          return {
            text: JSON.stringify({
              requiresInput,
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
              ...(!missingAuthority
                ? {
                    guestIntent: { state: "none", evidence, guests: [] },
                    noteIntent: { state: "none", evidence, sourceNote: null },
                  }
                : {}),
              clarification: "What time in the morning?",
              title: "Create extraction timing check",
              description: null,
              location: null,
              startAt,
              endAt: null,
              timeZone: "UTC",
              recurrence: null,
              travelOriginAddress: null,
              durationMinutes: 15,
              isShortPreparation: false,
            }),
            toolCalls: [],
            finishReason: "stop",
          };
        }
        return useModel(type, params);
      }) as typeof runtime.useModel);
      const { result } = await invoke(
        message(id, original),
        {
          action: "create_event",
          title: "Create extraction timing check",
          details: {
            start: "2026-07-30T10:00:00Z",
            end: "2026-07-30T10:15:00Z",
            timeZone: "UTC",
            calendarId: ELIZA_CALENDAR_ID,
            grantId: ELIZA_CALENDAR_GRANT_ID,
          },
        },
        false,
        calendarAction.name,
        "planner",
      );
      expect(extractionCalls, JSON.stringify(result)).toBe(1);
      expect(result.data?.awaitingUserInput, JSON.stringify(result)).toBe(true);
      if (missingAuthority)
        expect(result.effectReceipts?.[0]).toMatchObject({
          outcome: "failed",
          failure: {
            code: "CALENDAR_CREATE_AUTHORITY_UNRESOLVED",
            acceptance: "rejected",
          },
        });
      else expect(result.effectReceipts?.[0]?.outcome).toBe("noop");
      const feed = await calendar.getCalendarFeed(
        new URL("http://internal.local"),
        {
          timeMin: WINDOW_START,
          timeMax: WINDOW_END,
          includeHiddenCalendars: true,
        },
      );
      expect(
        feed.events.filter(
          (event) => event.title === "Create extraction timing check",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    "runtime",
    "runtime-none",
    "native",
    "legacy",
    "private",
    "invalid-native",
    "stale",
    "missing-agenda",
    "invalid-agenda",
  ] as const)(
    "keeps the actual enrolled Calendar feed source boundary (%s)",
    async (mode) => {
      const owner = randomUUID() as UUID,
        roomId = randomUUID() as UUID,
        worldId = randomUUID() as UUID;
      await runtime.createEntity({
        id: owner,
        names: ["Agenda boundary owner"],
        metadata: {},
      });
      await runtime.createWorld({
        id: worldId,
        name: "Agenda boundary world",
        agentId: runtime.agentId,
        metadata: {
          ownership: { ownerId: owner },
          roles: { [owner]: "OWNER" },
        },
      });
      await runtime.createRoom({
        id: roomId,
        worldId,
        name: "Agenda boundary room",
        source: "client_chat",
        type: ChannelType.DM,
      });
      const credential = {
        subjectUserId: `agenda-subject-${owner}`,
        installationId: randomUUID(),
        deviceKey: "c".repeat(64),
        capabilities: [CALENDAR_AGENDA_CAPABILITY],
      };
      const device = new DeviceActionService(runtime);
      await device.register(credential, "Synthetic agenda device");
      const nativeSource = {
        sourceId: "native-calendar",
        sourceRevision: "a".repeat(64),
      };
      const context = {
        view: "calendar",
        revision: 1,
        sensitive: mode === "private",
        timeZone: "America/Los_Angeles",
        ...(mode === "runtime-none"
          ? {}
          : {
              selectedObject:
                mode === "legacy"
                  ? {
                      kind: "legacy-app-calendar-source",
                      id: "legacy-app-calendar",
                      accountId: "device-local-legacy",
                      revision: "b".repeat(64),
                    }
                  : mode === "runtime"
                    ? {
                        kind: "canonical-calendar-source",
                        id: ELIZA_CALENDAR_ID,
                        accountId: ELIZA_CALENDAR_GRANT_ID,
                        revision: "1",
                        sourceRevision: "a".repeat(64),
                      }
                    : {
                        kind: "calendar-source",
                        id: nativeSource.sourceId,
                        revision:
                          mode === "invalid-native"
                            ? "bad-revision"
                            : nativeSource.sourceRevision,
                      },
            }),
      };
      // The bridge capability/source remains present even for runtime and legacy
      // selections. Neither is authority to substitute the native record store.
      const backend = vi.spyOn(calendar, "getCalendarFeed");
      const proposal = vi.spyOn(
        DeviceActionService.prototype,
        "proposeWithOutcome",
      );
      const enqueue = vi.spyOn(
        PgApprovalQueue.prototype,
        "enqueueTransactional",
      );
      const delivered: Content[] = [];
      let current = true;
      const result = await withDeviceActionTurn(
        runtime,
        credential,
        async () => {
          const nonce = randomUUID(),
            scope = JSON.stringify([runtime.agentId, roomId, owner]);
          const actor: Memory = {
            id: conversationClientUserMemoryId(scope, nonce),
            agentId: runtime.agentId,
            entityId: owner,
            roomId,
            createdAt: Date.now(),
            content: {
              text: "Show my calendar for October 29, 2026.",
              source: "client_chat",
              role: "user",
              channelType: "DM",
              chatIdempotency: {
                version: 1,
                scope,
                clientMessageId: nonce,
                fingerprint: "d".repeat(64),
              },
              metadata: {
                agentActionMode: "direct-request-v1",
                uiTimeZone: "America/Los_Angeles",
                clientDevice: {
                  context,
                  ...(mode === "missing-agenda"
                    ? {}
                    : {
                        calendarAgendaSource:
                          mode === "invalid-agenda"
                            ? { ...nativeSource, sourceRevision: "invalid" }
                            : nativeSource,
                      }),
                },
              },
            },
          };
          await runtime.createMemory(actor, "messages");
          setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
          setDeviceReadReplyContext(runtime, actor, {
            id: actor.id!,
            events: [],
          });
          if (mode === "stale") current = false;
          expect(currentAppRecordSource(runtime, "calendar", actor)).toBe(
            mode.startsWith("runtime")
              ? "runtime"
              : ["native", "missing-agenda", "invalid-agenda"].includes(mode)
                ? "device"
                : "unavailable",
          );
          return executePlannedToolCall(
            runtime,
            {
              message: actor,
              userRoles: ["OWNER"],
              activeContexts: ["calendar"],
              replyOwner: "planner",
              callback: async (content) => {
                delivered.push(content);
                return [];
              },
            },
            {
              name: "CALENDAR_FEED",
              params: {
                details: { date: "2026-10-29", endDate: "2026-10-29" },
              },
            },
            {
              actions: promoteSubactionsToActions(
                calendarAction,
                calendarActionPromotionOptions,
              ).filter((action) => action.name === "CALENDAR_FEED"),
            },
          );
        },
        {
          isCurrent: () => current,
          requestCaller: {
            subjectUserId: credential.subjectUserId,
            entityId: owner,
            role: "OWNER",
          },
        },
      );
      expect(delivered).toEqual([]);
      if (mode.startsWith("runtime")) {
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(backend).toHaveBeenCalledTimes(1);
        expect(proposal).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
      } else if (mode === "native") {
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(result.data).toMatchObject({
          proposalId: expect.any(String),
          localCalendarRead: false,
          executed: false,
        });
        expect(backend).not.toHaveBeenCalled();
        expect(proposal).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(result.effectReceipts?.[0]?.outcome).toBe("preview");
        expect(
          result.effectReceipts?.some(
            (receipt) => receipt.outcome === "applied",
          ),
        ).not.toBe(true);
      } else {
        expect(result.success, JSON.stringify(result)).toBe(false);
        expect(result.data, JSON.stringify(result)).toMatchObject({
          code:
            mode === "missing-agenda" || mode === "invalid-agenda"
              ? "CALENDAR_AGENDA_SOURCE_UNAVAILABLE"
              : "CALENDAR_AGENDA_UNAVAILABLE",
          retryable: false,
          localCalendarRead: false,
        });
        expect(backend).not.toHaveBeenCalled();
        expect(proposal).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(
          result.effectReceipts?.some(
            (receipt) => receipt.outcome === "applied",
          ),
        ).not.toBe(true);
      }
    },
  );

  it.each([
    "default",
    "end",
    "duration",
    "missing-clock",
    "invalid-duration",
    "negative-duration",
  ] as const)(
    "uses domain timing policy without invented extraction fields (%s)",
    async (mode) => {
      const index = [
        "default",
        "end",
        "duration",
        "missing-clock",
        "invalid-duration",
        "negative-duration",
      ].indexOf(mode);
      const date = `2030-05-${String(10 + index).padStart(2, "0")}`;
      const title = `Canonical timing policy ${mode}`;
      const original = `Create ${title} on ${date} ${mode === "missing-clock" ? "in the morning" : "at 5pm UTC"}${mode === "end" ? " until 5:45pm" : mode === "duration" ? " for 30 minutes" : mode === "invalid-duration" ? " for 0 minutes" : mode === "negative-duration" ? " for -5 minutes" : ""}.`;
      const actor = message(
        `00000000-0000-0000-0000-${String(998100 + index).padStart(12, "0")}`,
        original,
      );
      const evidence = [{ sourceId: `current:${actor.id}`, quote: original }];
      const model = runtime.useModel.bind(runtime);
      let extractionCalls = 0;
      let extractedTiming:
        | { endAt: string | null; durationMinutes: number | null }
        | undefined;
      vi.spyOn(runtime, "useModel").mockImplementation((async (
        type,
        params,
      ) => {
        if (
          type === ModelType.TEXT_LARGE &&
          String(params?.prompt).includes(
            "Extract calendar event creation fields",
          )
        ) {
          extractionCalls++;
          extractedTiming = {
            endAt: mode === "end" ? `${date}T17:45:00Z` : null,
            durationMinutes:
              mode === "duration"
                ? 30
                : mode === "invalid-duration"
                  ? 0
                  : mode === "negative-duration"
                    ? -5
                    : null,
          };
          return JSON.stringify({
            requiresInput: mode === "missing-clock",
            clarification: mode === "missing-clock" ? "What exact time?" : null,
            guestIntent: { state: "none", evidence, guests: [] },
            noteIntent: { state: "none", evidence, sourceNote: null },
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            title,
            description: null,
            location: null,
            startAt: mode === "missing-clock" ? null : `${date}T17:00:00Z`,
            ...extractedTiming,
            timeZone: "UTC",
            recurrence: null,
            travelOriginAddress: null,
            isShortPreparation: false,
          });
        }
        return model(type, params);
      }) as typeof runtime.useModel);
      const create = calendar.createCalendarEventMutation.bind(calendar);
      const requests: Array<
        Parameters<typeof calendar.createCalendarEventMutation>[1]
      > = [];
      vi.spyOn(calendar, "createCalendarEventMutation").mockImplementation(
        async (url, request) => {
          requests.push(structuredClone(request));
          return create(url, request);
        },
      );
      const { result } = await invoke(
        actor,
        {
          title,
          details: {
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            timeZone: "UTC",
          },
        },
        false,
        "CALENDAR_CREATE_EVENT",
        "planner",
      );
      expect(extractionCalls).toBe(1);
      const read = await calendar.getCalendarFeed(
        new URL("http://internal.local"),
        {
          grantId: ELIZA_CALENDAR_GRANT_ID,
          calendarId: ELIZA_CALENDAR_ID,
          timeMin: `${date}T00:00:00Z`,
          timeMax: `${date}T23:59:59Z`,
        },
      );
      const events = read.events.filter((event) => event.title === title);
      if (
        mode === "missing-clock" ||
        mode === "invalid-duration" ||
        mode === "negative-duration"
      ) {
        expect(result.success, JSON.stringify(result)).toBe(false);
        expect(events).toEqual([]);
        expect(requests).toEqual([]);
      } else {
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(result.effectReceipts?.[0]?.outcome).toBe("applied");
        expect(events).toHaveLength(1);
        expect(new Date(events[0].startAt).toISOString()).toBe(
          `${date}T17:00:00.000Z`,
        );
        expect(new Date(events[0].endAt).toISOString()).toBe(
          `${date}T${mode === "default" ? "18:00" : mode === "end" ? "17:45" : "17:30"}:00.000Z`,
        );
        expect(requests).toHaveLength(1);
        if (mode === "default") {
          expect(extractedTiming).toEqual({
            endAt: null,
            durationMinutes: null,
          });
          // The domain resolves its existing default before the mutation boundary.
          expect(new Date(requests[0].endAt!).toISOString()).toBe(
            `${date}T18:00:00.000Z`,
          );
        }
      }
    },
  );

  it.each([
    "ordinary",
    "spring-DST",
    "fall-DST",
    "fall-fold-ambiguous",
    "duplicate",
    "sensitive",
    "invalid-revision",
    "invalid-date",
    "zone-mismatch",
    "missing-day",
    "wrong-planner-name",
    "stale-version",
  ])(
    "serializes and admits the selected-day clock request through the registered store (%s)",
    async (mode) => {
      const original =
          mode === "fall-fold-ambiguous"
            ? "Move my 1:30am to 4"
            : "Move my 3pm to 4",
        zone = "America/Los_Angeles";
      const index = [
        "ordinary",
        "spring-DST",
        "fall-DST",
        "fall-fold-ambiguous",
        "duplicate",
        "sensitive",
        "invalid-revision",
        "invalid-date",
        "zone-mismatch",
        "missing-day",
        "wrong-planner-name",
        "stale-version",
      ].indexOf(mode);
      const uuid = (offset: number) =>
        `00000000-0000-0000-0000-${String(995000 + index * 10 + offset).padStart(12, "0")}`;
      const date =
        mode === "spring-DST"
          ? "2026-03-08"
          : mode === "fall-DST" || mode === "fall-fold-ambiguous"
            ? "2026-11-01"
            : "2026-10-29";
      const start =
        mode === "fall-fold-ambiguous"
          ? "2026-11-01T08:30:00Z"
          : mode === "spring-DST"
            ? "2026-03-08T22:00:00Z"
            : mode === "fall-DST"
              ? "2026-11-01T23:00:00Z"
              : mode === "wrong-planner-name"
                ? "2026-10-29T21:00:00Z"
                : "2026-10-29T22:00:00Z";
      const moved =
        mode === "spring-DST"
          ? "2026-03-08T23:00:00.000Z"
          : mode === "fall-DST"
            ? "2026-11-02T00:00:00.000Z"
            : "2026-10-29T23:00:00.000Z";
      const expectApplied = ["ordinary", "spring-DST", "fall-DST"].includes(
        mode,
      );
      await resolveOwnerFactStore(runtime).update(
        { timezone: zone },
        { source: "profile_save", recordedAt: "2026-10-28T12:00:00.000Z" },
      );
      const ownedEventIds: string[] = [];
      try {
        const created = await calendar.createCalendarEventMutation(
          new URL("http://internal.local/api/calendar"),
          {
            title: "Clock query registered fixture",
            startAt: start,
            endAt: new Date(Date.parse(start) + 1800000).toISOString(),
            timeZone: zone,
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
            idempotencyKey: `clock-query-registered-${mode}`,
          },
        );
        const target = created.event;
        if (!target) throw Error("Missing Calendar fixture");
        ownedEventIds.push(target.id);
        if (
          mode === "duplicate" ||
          mode === "wrong-planner-name" ||
          mode === "fall-fold-ambiguous"
        ) {
          const other = await calendar.createCalendarEventMutation(
            new URL("http://internal.local/api/calendar"),
            {
              title: "Other source clock",
              startAt:
                mode === "fall-fold-ambiguous"
                  ? "2026-11-01T09:30:00Z"
                  : "2026-10-29T22:00:00Z",
              endAt:
                mode === "fall-fold-ambiguous"
                  ? "2026-11-01T10:00:00Z"
                  : "2026-10-29T22:30:00Z",
              timeZone: zone,
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
              idempotencyKey: `clock-query-other-${mode}`,
            },
          );
          if (!other.event) throw Error("Missing second Calendar fixture");
          ownedEventIds.push(other.event.id);
        }
        const writes = vi.spyOn(calendar, "updateCalendarEvent");
        const version = target.metadata.etag;
        if (typeof version !== "string") throw Error("Missing fixture version");
        const useModel = runtime.useModel.bind(runtime);
        let extractionCalls = 0;
        vi.spyOn(runtime, "useModel").mockImplementation((async (
          type,
          params,
        ) => {
          if (
            type === ModelType.TEXT_LARGE &&
            String(params?.prompt).includes(
              "Extract calendar event update fields",
            )
          ) {
            extractionCalls++;
            if (mode === "stale-version")
              await calendar.updateCalendarEvent(
                new URL("http://internal.local/api/calendar"),
                {
                  eventId: target.externalId,
                  grantId: ELIZA_CALENDAR_GRANT_ID,
                  calendarId: ELIZA_CALENDAR_ID,
                  description: "Concurrent owner change",
                  expectedProviderVersion: version,
                  idempotencyKey: "clock-concurrent-owner-change",
                },
              );
            return {
              text: JSON.stringify({
                requiresInput: false,
                title: null,
                description: null,
                location: null,
                clearFields: [],
                startAt: `${date}T16:00:00`,
                endAt: null,
                timeZone: zone,
                recurrence: null,
                recurrenceScope: null,
                clarification: null,
              }),
              toolCalls: [],
              finishReason: "stop",
            };
          }
          return useModel(type, params);
        }) as typeof runtime.useModel);
        const actor = message(uuid(1), original);
        const worldId = uuid(3) as UUID;
        actor.roomId = uuid(2) as UUID;
        await runtime.createWorld({
          id: worldId,
          name: "Clock query test",
          agentId: runtime.agentId,
          serverId: "clock-query-test",
        });
        await runtime.createRoom({
          id: actor.roomId,
          agentId: runtime.agentId,
          worldId,
          source: "client_chat",
          type: ChannelType.DM,
        });
        actor.createdAt = Date.parse("2026-10-28T12:00:00Z");
        const context = {
          view: "calendar",
          revision: mode === "invalid-revision" ? -1 : 3,
          sensitive: mode === "sensitive",
          timeZone: zone,
          ...(mode === "missing-day"
            ? {}
            : {
                calendarDay: {
                  date: mode === "invalid-date" ? "2026-02-30" : date,
                  timeZone: mode === "zone-mismatch" ? "UTC" : zone,
                },
              }),
        };
        let captured: unknown;
        const client = new ElizaClient("https://calendar-fixture.invalid");
        client.setRequestTransport({
          async request(_url, init) {
            captured = JSON.parse(String(init.body));
            return new Response(
              JSON.stringify({ text: "Serialized", agentName: "fixture" }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        });
        await client.sendConversationMessage(
          actor.roomId,
          original,
          "DM",
          undefined,
          { clientDevice: { context }, userTextFormat: "plain-v1" },
        );
        const req = new IncomingMessage(new Socket());
        const res = new ServerResponse(req);
        const wire = await readChatRequestPayload(req, res, {
          runtime,
          readJsonBody: async <T extends object>() =>
            structuredClone(captured) as T,
          error: (_res, message) => {
            throw new Error(message);
          },
        });
        if (!wire) throw new Error("Canonical chat request was not admitted");
        expect(wire.prompt).toBe(original);
        actor.content = {
          ...actor.content,
          text: wire.prompt,
          metadata: wire.metadata,
        };
        const malformed = [
          "sensitive",
          "invalid-revision",
          "invalid-date",
          "zone-mismatch",
        ].includes(mode);
        const device = wire.metadata?.clientDevice;
        if (
          !device ||
          typeof device !== "object" ||
          Array.isArray(device) ||
          !Object.hasOwn(device, "context")
        )
          throw Error("Serialized current context missing");
        const serializedContext = Reflect.get(device, "context");
        const read = () => parseClientTurnObservation(serializedContext);
        if (malformed) {
          expect(read).toThrow();
          expect(
            projectClientObservation(actor.content).observation,
          ).toBeUndefined();
        } else {
          expect(read().calendarDay).toEqual(
            mode === "missing-day" ? undefined : context.calendarDay,
          );
          expect(projectClientObservation(actor.content).observation).toEqual(
            read(),
          );
        }
        // The five detail keys match the failed live parent call; planner timing
        // and duration deliberately contradict the original-request extraction.
        const serialized = JSON.parse(
          JSON.stringify({
            action: "update_event",
            intent: original,
            details: {
              start: "2026-10-29T19:00:00",
              end: "2026-10-29T19:30:00",
              date,
              query:
                mode === "wrong-planner-name"
                  ? target.title
                  : mode === "fall-fold-ambiguous"
                    ? "1:30am"
                    : "3pm",
              durationMinutes: 99,
            },
          }),
        );
        const { result } = await invoke(
          actor,
          serialized,
          false,
          calendarAction.name,
          "planner",
        );
        expect(result.success, JSON.stringify(result)).toBe(expectApplied);
        expect(extractionCalls).toBe(
          expectApplied || mode === "stale-version" ? 1 : 0,
        );
        if (expectApplied)
          expect(result.effectReceipts?.[0]?.outcome).toBe("applied");
        else
          expect(
            result.effectReceipts?.some(
              (receipt) => receipt.outcome === "applied",
            ),
          ).not.toBe(true);
        expect(writes).toHaveBeenCalledTimes(
          mode === "stale-version" ? 2 : expectApplied ? 1 : 0,
        );
        const updated = await calendar.getConditionalCalendarMutationTarget(
          new URL("http://internal.local/api/calendar"),
          {
            eventId: target.id,
            grantId: ELIZA_CALENDAR_GRANT_ID,
            calendarId: ELIZA_CALENDAR_ID,
          },
        );
        expect(updated).toMatchObject({
          id: target.id,
          title: target.title,
          startAt: expectApplied ? moved : new Date(start).toISOString(),
          endAt: expectApplied
            ? new Date(Date.parse(moved) + 1800000).toISOString()
            : new Date(Date.parse(start) + 1800000).toISOString(),
          metadata: {
            version: expectApplied || mode === "stale-version" ? 2 : 1,
          },
        });
        expect(updated.location).toBe(target.location);
        expect(updated.description).toBe(
          mode === "stale-version"
            ? "Concurrent owner change"
            : target.description,
        );
      } finally {
        // Each mode owns exactly these synthetic records. Negative cases leave
        // their event unchanged; retain no same-clock records to pollute the next case.
        for (const eventId of ownedEventIds) {
          const current = await calendar.getConditionalCalendarMutationTarget(
            new URL("http://internal.local/api/calendar"),
            {
              eventId,
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
            },
          );
          await calendar.deleteCalendarEvent(
            new URL("http://internal.local/api/calendar"),
            {
              eventId: current.externalId,
              grantId: ELIZA_CALENDAR_GRANT_ID,
              calendarId: ELIZA_CALENDAR_ID,
              expectedProviderVersion: String(current.metadata.etag),
              idempotencyKey: `clock-fixture-cleanup-${mode}-${eventId}`,
            },
          );
        }
        await resolveOwnerFactStore(runtime).clear();
      }
    },
  );

  it("preserves update extraction controls through the registered host action", async () => {
    const created = await calendar.createCalendarEventMutation(
      new URL("http://internal.local/api/calendar"),
      {
        title: "Host extraction check",
        startAt: EVENT_START,
        endAt: EVENT_END,
        timeZone: "UTC",
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        idempotencyKey: "host-extraction-check",
      },
    );
    const target = created.event;
    if (!target) throw new Error("Calendar fixture was not created");
    const useModel = runtime.useModel.bind(runtime);
    let extractionCalls = 0;
    vi.spyOn(runtime, "useModel").mockImplementation((async (type, params) => {
      if (
        type === ModelType.TEXT_LARGE &&
        String(params?.prompt).includes("Extract calendar event update fields")
      ) {
        extractionCalls += 1;
        expect(params).toMatchObject({
          temperature: 0,
          responseSchema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "requiresInput",
              "startAt",
              "endAt",
            ]),
          },
        });
        return {
          text: JSON.stringify({
            requiresInput: true,
            clarification: "What time?",
          }),
          toolCalls: [],
          finishReason: "stop",
        };
      }
      return useModel(type, params);
    }) as typeof runtime.useModel);
    const { result } = await invoke(
      message(
        "00000000-0000-0000-0000-000000009979",
        "Move Host extraction check to tomorrow morning.",
      ),
      {
        action: "update_event",
        details: {
          eventId: target?.id,
          calendarId: ELIZA_CALENDAR_ID,
          grantId: ELIZA_CALENDAR_GRANT_ID,
        },
      },
      false,
      calendarAction.name,
      "planner",
    );
    expect(extractionCalls, JSON.stringify(result)).toBe(1);
    expect(result.data?.awaitingUserInput).toBe(true);
    expect(result.effectReceipts?.[0]?.outcome).toBe("noop");
    const unchanged = await calendar.getConditionalCalendarMutationTarget(
      new URL("http://internal.local/api/calendar"),
      {
        eventId: target.id,
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
      },
    );
    expect(unchanged.startAt).toBe(target?.startAt);
    expect(unchanged.endAt).toBe(target?.endAt);
    expect(unchanged.metadata.etag).toBe(target?.metadata.etag);
  });

  it("atomically distinguishes first approval, concurrent replay, and later replay", async () => {
    const fixture = googleHandoffFixture();
    const grant = writableGrant(String(runtime.agentId));
    calendar.setGate({
      ...gate(String(runtime.agentId)),
      getGoogleConnectorAccounts: async () => [{ ...fixture.status, grant }],
    });
    const getService = runtime.getService.bind(runtime);
    vi.spyOn(runtime, "getService").mockImplementation(((name: string) =>
      name === "google"
        ? {
            listCalendars: async () => [
              { ...fixture.entry, calendarId: "primary" },
            ],
            listEventPage: async () => ({
              events: [],
              nextPageToken: null,
              nextSyncToken: null,
            }),
          }
        : getService(name)) as typeof runtime.getService);
    await new CalendarRepository(runtime).upsertCalendarSyncState({
      id: `${runtime.agentId}:google:owner:grant:connector-account:calendar-receipt-owner:calendar:primary`,
      agentId: String(runtime.agentId),
      provider: "google",
      side: "owner",
      grantId: "connector-account:calendar-receipt-owner",
      connectorAccountId: "calendar-receipt-owner",
      calendarId: "primary",
      windowStartAt: "2026-01-01T00:00:00.000Z",
      windowEndAt: "2027-01-01T00:00:00.000Z",
      nextSyncToken: null,
      syncedAt: SOURCE_SYNCED_AT,
      updatedAt: SOURCE_SYNCED_AT,
    });
    // This test exercises approval replay, with explicit extraction output;
    // the domain timing-authority tests cover missing/fabricated timing.
    const actor = message(
      "00000000-0000-0000-0000-000000009931",
      "Add family planning on owner@example.test primary Google calendar on July 30, 2026 from 5 to 6 PM UTC.",
    );
    const useModel = runtime.useModel.bind(runtime);
    vi.spyOn(runtime, "useModel").mockImplementation((async (type, params) => {
      if (
        type === ModelType.TEXT_LARGE &&
        String(params?.prompt).includes(
          "Extract calendar event creation fields",
        )
      ) {
        expect(params?.temperature).toBe(0);
        const evidence = [
          { sourceId: `current:${actor.id}`, quote: actor.content.text },
        ];
        return JSON.stringify({
          requiresInput: false,
          clarification: null,
          guestIntent: { state: "none", evidence, guests: [] },
          noteIntent: { state: "none", evidence, sourceNote: null },
          grantId: grant.id,
          calendarId: "primary",
          title: "Family planning",
          description: null,
          location: null,
          startAt: "2026-07-30T17:00:00Z",
          endAt: "2026-07-30T18:00:00Z",
          timeZone: "UTC",
          recurrence: null,
          travelOriginAddress: null,
          durationMinutes: 60,
          isShortPreparation: false,
        });
      }
      return useModel(type, params);
    }) as typeof runtime.useModel);

    const params = {
      action: "create_event",
      title: "Family planning",
      details: {
        side: "owner",
        grantId: "connector-account:calendar-receipt-owner",
        calendarId: "primary",
        start: "2026-07-30T17:00:00.000Z",
        end: "2026-07-30T18:00:00.000Z",
        timeZone: "UTC",
      },
    };
    const concurrent = await Promise.all([
      invoke(actor, params),
      invoke(actor, params),
    ]);
    expect(
      concurrent
        .map(({ result }) => result.effectReceipts?.[0]?.outcome)
        .sort(),
      JSON.stringify(concurrent.map(({ result }) => result)),
    ).toEqual(["applied", "noop"]);
    const requestIds = concurrent.map(
      ({ result }) =>
        (result.data as { approvalRequestId?: string } | undefined)
          ?.approvalRequestId,
    );
    expect(new Set(requestIds).size).toBe(1);
    const requestId = requestIds[0];
    if (!requestId) throw new Error("approval request id was not returned");
    // Reads are subject-fenced: the calendar action enqueues under the
    // actor's entityId, which this harness sets to the agent.
    const persisted = await createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    }).byId(requestId, String(runtime.agentId));
    if (!persisted) throw new Error("approval request was not persisted");
    for (const { result } of concurrent) {
      expect(result.effectReceipts?.[0]).toMatchObject({
        observedAt: persisted.createdAt.toISOString(),
        resource: { id: persisted.id },
        idempotency: { key: persisted.idempotencyKey },
      });
    }

    const replay = (await invoke(actor, params)).result;
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
      resource: { id: persisted.id },
    });
  });
});

it("grounds the observed relative-create reply against the real CalendarService event and receipt", async () => {
  const original = "Create an event to meet with Shaw in 20 mins for 1hr";
  const actor = message(randomUUID(), original);
  actor.createdAt = Date.parse("2026-10-29T23:32:29.000Z");
  const startAt = "2026-10-29T23:52:29.000Z",
    endAt = "2026-10-30T00:52:29.000Z";
  const evidence = [{ sourceId: `current:${actor.id}`, quote: original }];
  const model = runtime.useModel.bind(runtime);
  vi.spyOn(runtime, "useModel").mockImplementation((async (type, params) => {
    if (
      type === ModelType.TEXT_LARGE &&
      String(params?.prompt).includes("Extract calendar event creation fields")
    )
      return JSON.stringify({
        requiresInput: false,
        clarification: null,
        guestIntent: { state: "none", evidence, guests: [] },
        noteIntent: { state: "none", evidence, sourceNote: null },
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
        title: "Meet with Shaw",
        description: null,
        location: null,
        startAt,
        endAt,
        timeZone: "America/Los_Angeles",
        recurrence: null,
        travelOriginAddress: null,
        durationMinutes: 60,
        isShortPreparation: false,
      });
    return model(type, params);
  }) as typeof runtime.useModel);
  const { result } = await invoke(
    actor,
    {
      action: "create_event",
      details: {
        grantId: ELIZA_CALENDAR_GRANT_ID,
        calendarId: ELIZA_CALENDAR_ID,
      },
    },
    false,
    calendarAction.name,
    "planner",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  const event = result.data?.event;
  if (!isObjectRecord(event) || !isObjectRecord(event.metadata))
    throw Error("Created event shape missing");
  expect(event).toMatchObject({
    agentId: runtime.agentId,
    startAt,
    endAt,
    timezone: "America/Los_Angeles",
  });
  const receipt = result.effectReceipts?.find(
    (entry) => entry.operation === "calendar.event.create",
  );
  expect(receipt?.outcome).toBe("applied");
  expect(receipt?.resource.id).toBe(event?.id);
  expect(receipt?.resource.version).toBe(event?.metadata?.etag);
  const { evaluatePlannedReplyEgress, resolvePlannedReplyEgress } =
    await import(
      "../../plugin-assistant/src/services/message/egress-policy.ts"
    );
  const wrong = "Done. Meet with Shaw, tonight 5:52 to 6:52 PM.",
    correct = "Created your meeting with Shaw for today, 4:52–5:52 PM.";
  expect(
    evaluatePlannedReplyEgress({
      reply: wrong,
      request: original,
      currentScope: actor,
      actionResults: [result],
      actions: runtime.actions,
    }),
  ).toEqual({ verdict: "reject", kind: "calendar_time" });
  let calls = 0;
  vi.spyOn(runtime, "useModel").mockImplementation((async (type, params) => {
    if (type !== ModelType.TEXT_SMALL)
      throw Error("No additional action/model execution expected");
    calls++;
    return String(params.prompt).startsWith("Review recovered reply grounding.")
      ? JSON.stringify({
          grounded: true,
          claims: [
            {
              quote: correct,
              actor: "assistant",
              change: true,
              supported: true,
              evidence: receipt?.receiptId,
            },
          ],
        })
      : JSON.stringify({
          response: correct,
          effectReceiptIds: [receipt?.receiptId],
        });
  }) as typeof runtime.useModel);
  const before = structuredClone(result);
  const output = await resolvePlannedReplyEgress({
    runtime,
    message: actor,
    reply: wrong,
    actionResults: [result],
  });
  expect(output.text).toBe(correct);
  expect(calls).toBe(2);
  expect(result).toEqual(before);
  const feed = await calendar.getCalendarFeed(
    new URL("http://internal.local"),
    {
      grantId: ELIZA_CALENDAR_GRANT_ID,
      calendarId: ELIZA_CALENDAR_ID,
      timeMin: "2026-10-29T23:00:00.000Z",
      timeMax: "2026-10-30T02:00:00.000Z",
    },
  );
  expect(feed.events.filter((entry) => entry.id === event?.id)).toHaveLength(1);
  expect(feed.events.find((entry) => entry.id === event?.id)).toMatchObject({
    startAt,
    endAt,
  });
});
