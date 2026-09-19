/**
 * Drives the registered CALENDAR action through the canonical executor over
 * real PGlite calendar, task, and approval stores. Only the remote ICS and
 * secret-vault boundaries are in-memory; every asserted receipt is read back
 * from the same persisted snapshot or row the action consumed.
 */

import {
  type ActionResult,
  type AgentRuntime,
  type Content,
  executePlannedToolCall,
  type Memory,
  ModelType,
  promoteSubactionsToActions,
  SECRETS_SERVICE_TYPE,
  type UUID,
} from "@elizaos/core";
import {
  type CalendarHostGate,
  CalendarRepository,
  CalendarService,
  ELIZA_CALENDAR_GRANT_ID,
  ELIZA_CALENDAR_ID,
} from "@elizaos/plugin-calendar";
import type { LifeOpsConnectorGrant } from "@elizaos/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  calendarAction,
  calendarActionPromotionOptions,
} from "../src/actions/calendar.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { resolveOwnerFactStore } from "../src/lifeops/owner/fact-store.js";
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
    expect(result.transcriptVisibility).toBe("internal");
    expect(result.userFacingText).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
  }
  expect(result.effectReceipts).toHaveLength(1);
  return { delivered, result };
}

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
    transport: {
      fetchImpl: async () =>
        new Response(icsBody(), {
          status: 200,
          headers: {
            "content-type": "text/calendar",
            etag: '"receipt-suite-v1"',
          },
        }),
    },
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
  });

  it("returns a settled observation for planner-owned availability reads", async () => {
    const collaborator = await import("@elizaos/agent");
    const { renderGroundedActionReply } = await import(
      "../../../packages/agent/src/actions/grounded-action-reply.js"
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

  it.each([undefined, "planner"] as const)(
    "proposes a new window and awaits selection without changing the event (reply owner %s)",
    async (replyOwner) => {
      if (replyOwner === "planner") {
        // Exercise the real deferred renderer; the package's default collaborator
        // always returns a standalone model reply and cannot represent this path.
        const collaborator = await import("@elizaos/agent");
        const { renderGroundedActionReply } = await import(
          "../../../packages/agent/src/actions/grounded-action-reply.js"
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
    const useModel = runtime.useModel.bind(runtime);
    vi.spyOn(runtime, "useModel").mockImplementation((async (type, params) => {
      if (
        type === ModelType.TEXT_LARGE &&
        String(params?.prompt).includes(
          "Extract calendar event creation fields",
        )
      ) {
        expect(params?.temperature).toBe(0);
        return JSON.stringify({
          title: "Family planning",
          startAt: "2026-07-30T17:00:00Z",
          endAt: "2026-07-30T18:00:00Z",
          timeZone: "UTC",
        });
      }
      return useModel(type, params);
    }) as typeof runtime.useModel);
    const actor = message(
      "00000000-0000-0000-0000-000000009931",
      "Add family planning on July 30, 2026 from 5 to 6 PM UTC.",
    );
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
