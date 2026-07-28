/**
 * Real-PGlite proof that authenticated editor gestures share the durable
 * calendar claim ledger, suppress replay across service restarts, and preserve
 * Apple add-only receipts without fabricating readable events.
 */
import {
  APPROVAL_SERVICE,
  ApprovalService,
  resolveApprovalService,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { CalendarServiceError } from "@elizaos/plugin-calendar";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import {
  type OwnerCalendarMutationGatewayDeps,
  OwnerCalendarMutationGatewayService,
} from "./owner-editor-gateway.js";
import type { CalendarMutationPort, CalendarMutationReceipt } from "./types.js";

let fixtureAgentId = "editor-gateway-test";

function event(): LifeOpsCalendarEvent {
  return {
    id: "editor-created-row-1",
    externalId: "provider-created-1",
    agentId: fixtureAgentId,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "School pickup",
    description: "",
    location: "School",
    status: "confirmed",
    startAt: "2027-03-14T18:00:00.000Z",
    endAt: "2027-03-14T18:30:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer: { self: true, email: "owner@example.com" },
    attendees: [],
    metadata: { etag: '"created-v1"' },
    syncedAt: "2027-03-01T00:00:00.000Z",
    updatedAt: "2027-03-01T00:00:00.000Z",
    grantId: "google-calendar-owner-grant",
    connectorAccountId: "owner-account",
    accountEmail: "owner@example.com",
  };
}

function readableReceipt(
  created: LifeOpsCalendarEvent,
  overrides: Partial<CalendarMutationReceipt> = {},
): CalendarMutationReceipt {
  return {
    operation: "schedule_event",
    provider: "google",
    sourceId: created.grantId ?? "google-calendar-owner-grant",
    calendarId: created.calendarId,
    eventId: created.id,
    providerEventId: created.externalId,
    providerVersion: '"created-v1"',
    readBackAvailable: true,
    accessLevel: "readable",
    eventSnapshot: created,
    recurrenceScope: null,
    cancellationMode: null,
    acceptedAt: "2027-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("OwnerCalendarMutationGatewayService — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let providerCalls: number;
  let storedEvent: LifeOpsCalendarEvent | null;
  let executedApprovals: ApprovalRequest[];

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    fixtureAgentId = String(runtime.agentId);
    await runtime.registerService(ApprovalService);
    await runtime.getServiceLoadPromise(APPROVAL_SERVICE);
    expect(resolveApprovalService(runtime)).toBeInstanceOf(ApprovalService);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  beforeEach(() => {
    providerCalls = 0;
    storedEvent = null;
    executedApprovals = [];
  });

  function deps(
    port: CalendarMutationPort,
    approvalQueue: ApprovalQueue = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    }),
  ): OwnerCalendarMutationGatewayDeps {
    return {
      approvalQueue,
      calendar: {
        async getConditionalCalendarMutationTarget() {
          if (!storedEvent) {
            throw new CalendarServiceError(
              404,
              "Fixture event missing.",
              "CALENDAR_EVENT_NOT_FOUND",
            );
          }
          return storedEvent;
        },
      },
      port,
    };
  }

  function readablePort(
    beforeReceipt?: () => Promise<void>,
  ): CalendarMutationPort {
    return {
      async preflight() {
        return {
          operation: "schedule_event",
          provider: "google",
          sourceId: "google-calendar-owner-grant",
          calendarId: "primary",
          event: null,
          providerEventId: null,
          providerVersion: null,
          idempotencyKey: "provider-stable-create-1",
          recurrenceScope: null,
          cancellationMode: null,
        };
      },
      async execute(request) {
        providerCalls += 1;
        executedApprovals.push(request);
        await beforeReceipt?.();
        storedEvent = event();
        return readableReceipt(storedEvent);
      },
    };
  }

  const createRequest = {
    side: "owner" as const,
    grantId: "google-calendar-owner-grant",
    calendarId: "primary",
    title: "School pickup",
    startAt: "2027-03-14T18:00:00.000Z",
    endAt: "2027-03-14T18:30:00.000Z",
    timeZone: "America/Los_Angeles",
    idempotencyKey: "owner-editor-create-1",
    notifyAttendees: false,
  };

  it("replays one durable provider receipt across service restarts", async () => {
    const first = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort()),
    );
    const created = await first.create(
      new URL("http://internal.local"),
      createRequest,
    );
    expect(created).toMatchObject({
      outcome: "event",
      event: {
        externalId: "provider-created-1",
        title: "School pickup",
      },
    });

    storedEvent = null;
    const restarted = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort()),
    );
    const replay = await restarted.create(
      new URL("http://internal.local"),
      createRequest,
    );
    expect(replay).toMatchObject({
      outcome: "event",
      event: {
        externalId: "provider-created-1",
        title: "School pickup",
      },
    });
    expect(providerCalls).toBe(1);
  });

  it("replays an update from its immutable receipt after the mutable cache disappears", async () => {
    storedEvent = event();
    const updatedEvent = {
      ...event(),
      title: "Updated pickup",
      metadata: { etag: '"updated-v2"' },
      updatedAt: "2027-03-01T01:00:00.000Z",
    };
    const updatePort: CalendarMutationPort = {
      async preflight() {
        return {
          operation: "modify_event",
          provider: "google",
          sourceId: "google-calendar-owner-grant",
          calendarId: "primary",
          event: storedEvent,
          providerEventId: "provider-created-1",
          providerVersion: '"created-v1"',
          idempotencyKey: null,
          recurrenceScope: null,
          cancellationMode: null,
        };
      },
      async execute() {
        providerCalls += 1;
        storedEvent = updatedEvent;
        return readableReceipt(updatedEvent, {
          operation: "modify_event",
          providerVersion: '"updated-v2"',
        });
      },
    };
    const request = {
      side: "owner" as const,
      grantId: "google-calendar-owner-grant",
      calendarId: "primary",
      eventId: "provider-created-1",
      title: "Updated pickup",
      expectedProviderVersion: '"created-v1"',
      idempotencyKey: "owner-editor-update-replay-1",
      notifyAttendees: false,
    };
    const first = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(updatePort),
    );
    await expect(
      first.update(new URL("http://internal.local"), request),
    ).resolves.toMatchObject({
      title: "Updated pickup",
      metadata: { etag: '"updated-v2"' },
    });

    storedEvent = null;
    const restarted = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(updatePort),
    );
    await expect(
      restarted.update(new URL("http://internal.local"), request),
    ).resolves.toMatchObject({
      title: "Updated pickup",
      metadata: { etag: '"updated-v2"' },
    });
    expect(providerCalls).toBe(1);
  });

  it("binds the selected occurrence and series master before a following-series update", async () => {
    const master: LifeOpsCalendarEvent = {
      ...event(),
      id: "editor-series-master-row",
      externalId: "provider-series-master",
      title: "Weekly school pickup",
      startAt: "2027-02-28T18:00:00.000Z",
      endAt: "2027-02-28T18:30:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"],
      recurringEventId: null,
      metadata: { etag: '"series-master-v1"' },
      updatedAt: "2027-03-01T00:05:00.000Z",
    };
    const occurrence: LifeOpsCalendarEvent = {
      ...event(),
      id: "editor-series-occurrence-row",
      externalId: "provider-series-occurrence-3",
      title: master.title,
      recurringEventId: master.externalId,
      metadata: {
        etag: '"series-occurrence-v3"',
        recurringEventId: master.externalId,
        originalStartTime: event().startAt,
        originalStartIsAllDay: false,
      },
    };
    const following: LifeOpsCalendarEvent = {
      ...occurrence,
      id: "editor-following-series-row",
      externalId: "provider-following-series",
      title: "Updated weekly pickup",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"],
      recurringEventId: null,
      metadata: { etag: '"following-series-v1"' },
      updatedAt: "2027-03-01T01:00:00.000Z",
    };
    const followingPort: CalendarMutationPort = {
      async preflight() {
        return {
          operation: "modify_event",
          provider: "google",
          sourceId: "google-calendar-owner-grant",
          calendarId: "primary",
          event: master,
          providerEventId: master.externalId,
          providerVersion: '"series-master-v1"',
          idempotencyKey: "provider-following-operation-1",
          recurrenceScope: "this_and_following",
          cancellationMode: null,
        };
      },
      async execute(request) {
        providerCalls += 1;
        executedApprovals.push(request);
        return readableReceipt(following, {
          operation: "modify_event",
          providerVersion: '"following-series-v1"',
          recurrenceScope: "this_and_following",
        });
      },
    };
    const gateway = new OwnerCalendarMutationGatewayService(runtime, {
      approvalQueue: createApprovalQueue(runtime, {
        agentId: runtime.agentId,
      }),
      calendar: {
        async getConditionalCalendarMutationTarget(_requestUrl, request) {
          return request.recurrenceScope === "series" ? master : occurrence;
        },
      },
      port: followingPort,
    });

    await expect(
      gateway.update(new URL("http://internal.local"), {
        side: "owner",
        grantId: "google-calendar-owner-grant",
        calendarId: "primary",
        eventId: occurrence.externalId,
        title: following.title,
        recurrenceScope: "this_and_following",
        notifyAttendees: true,
        expectedProviderVersion: '"series-occurrence-v3"',
        idempotencyKey: "owner-editor-following-update-1",
      }),
    ).resolves.toMatchObject({
      externalId: following.externalId,
      title: following.title,
    });
    expect(executedApprovals).toHaveLength(1);
    expect(executedApprovals[0]).toMatchObject({
      reason: expect.stringContaining(
        "Later per-occurrence exceptions will reset",
      ),
      payload: {
        action: "modify_event",
        eventId: occurrence.externalId,
        expectedProviderVersion: '"series-occurrence-v3"',
        recurrenceScope: "this_and_following",
        seriesMaster: {
          externalId: master.externalId,
          startAtMs: Date.parse(master.startAt),
          updatedAt: master.updatedAt,
          etag: '"series-master-v1"',
        },
      },
    });
    expect(providerCalls).toBe(1);
  });

  it("returns an updated invitation snapshot instead of claiming a deletion", async () => {
    storedEvent = {
      ...event(),
      organizer: { self: false, email: "host@example.com" },
      attendees: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          responseStatus: "accepted",
          self: true,
          organizer: false,
          optional: false,
        },
      ],
    };
    const declinedEvent: LifeOpsCalendarEvent = {
      ...storedEvent,
      attendees: storedEvent.attendees.map((attendee) => ({
        ...attendee,
        responseStatus: attendee.self ? "declined" : attendee.responseStatus,
      })),
      metadata: { etag: '"declined-v2"' },
      updatedAt: "2027-03-01T01:00:00.000Z",
    };
    const declinePort: CalendarMutationPort = {
      async preflight() {
        return {
          operation: "cancel_event",
          provider: "google",
          sourceId: "google-calendar-owner-grant",
          calendarId: "primary",
          event: storedEvent,
          providerEventId: "provider-created-1",
          providerVersion: '"created-v1"',
          idempotencyKey: null,
          recurrenceScope: null,
          cancellationMode: "decline_invitation",
        };
      },
      async execute() {
        providerCalls += 1;
        storedEvent = declinedEvent;
        return readableReceipt(declinedEvent, {
          operation: "cancel_event",
          providerVersion: '"declined-v2"',
          cancellationMode: "decline_invitation",
        });
      },
    };
    const result = await new OwnerCalendarMutationGatewayService(
      runtime,
      deps(declinePort),
    ).cancel(new URL("http://internal.local"), {
      side: "owner",
      grantId: "google-calendar-owner-grant",
      calendarId: "primary",
      eventId: "provider-created-1",
      expectedProviderVersion: '"created-v1"',
      idempotencyKey: "owner-editor-decline-1",
      notifyAttendees: false,
      cancellationMode: "decline_invitation",
    });
    expect(result).toMatchObject({
      outcome: "invitation_declined",
      cancellationMode: "decline_invitation",
      event: {
        attendees: [
          {
            self: true,
            responseStatus: "declined",
          },
        ],
      },
    });
    expect(providerCalls).toBe(1);
  });

  it("blocks an in-flight duplicate and sends exactly one provider create", async () => {
    let release: (() => void) | null = null;
    let observed: (() => void) | null = null;
    const providerObserved = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(
        readablePort(async () => {
          observed?.();
          await providerRelease;
        }),
      ),
    );
    const first = gateway.create(new URL("http://internal.local"), {
      ...createRequest,
      idempotencyKey: "owner-editor-concurrent-1",
    });
    await providerObserved;
    await expect(
      gateway.create(new URL("http://internal.local"), {
        ...createRequest,
        idempotencyKey: "owner-editor-concurrent-1",
      }),
    ).rejects.toMatchObject({
      code: "CALENDAR_MUTATION_IN_FLIGHT",
    });
    release?.();
    await first;
    expect(providerCalls).toBe(1);
  });

  it("rejects reuse of an operation key with different event bytes", async () => {
    const gateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort()),
    );
    await gateway.create(new URL("http://internal.local"), {
      ...createRequest,
      idempotencyKey: "owner-editor-collision-1",
    });
    await expect(
      gateway.create(new URL("http://internal.local"), {
        ...createRequest,
        title: "Different event",
        idempotencyKey: "owner-editor-collision-1",
      }),
    ).rejects.toMatchObject({
      code: "CALENDAR_EDITOR_IDEMPOTENCY_CONFLICT",
    });
    expect(providerCalls).toBe(1);
  });

  it.each([
    ["spring gap", "2027-03-14T02:30:00", "2027-03-14T03:30:00"],
    ["fall fold", "2027-11-07T01:30:00", "2027-11-07T02:30:00"],
  ])(
    "rejects offset-less Los Angeles %s editor times before approval",
    async (_label, startAt, endAt) => {
      const gateway = new OwnerCalendarMutationGatewayService(
        runtime,
        deps(readablePort()),
      );
      await expect(
        gateway.create(new URL("http://internal.local"), {
          ...createRequest,
          startAt,
          endAt,
          timeZone: "America/Los_Angeles",
          idempotencyKey: `owner-editor-offsetless-${startAt}`,
        }),
      ).rejects.toMatchObject({
        code: "CALENDAR_EDITOR_TIMESTAMP_INVALID",
        status: 400,
      });
      expect(executedApprovals).toHaveLength(0);
      expect(providerCalls).toBe(0);
    },
  );

  it("preserves explicit offsets, timezone, and optional attendee metadata in the immutable approval", async () => {
    const gateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort()),
    );
    await gateway.create(new URL("http://internal.local"), {
      ...createRequest,
      startAt: "2027-03-14T01:30:00-08:00",
      endAt: "2027-03-14T03:30:00-07:00",
      timeZone: "America/Los_Angeles",
      attendees: [
        {
          email: "coparent@example.com",
          displayName: "Morgan",
          optional: true,
        },
      ],
      idempotencyKey: "owner-editor-explicit-offset-1",
    });
    expect(executedApprovals).toHaveLength(1);
    expect(executedApprovals[0]?.payload).toMatchObject({
      action: "schedule_event",
      startsAtMs: Date.parse("2027-03-14T01:30:00-08:00"),
      endsAtMs: Date.parse("2027-03-14T03:30:00-07:00"),
      timeZone: "America/Los_Angeles",
      attendees: [
        {
          email: "coparent@example.com",
          displayName: "Morgan",
          optional: true,
        },
      ],
    });
  });

  it("resolves preset and duration into an exact immutable range", async () => {
    const gateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort()),
    );
    const {
      startAt: _startAt,
      endAt: _endAt,
      ...presetRequest
    } = createRequest;
    await gateway.create(new URL("http://internal.local"), {
      ...presetRequest,
      timeZone: "America/Los_Angeles",
      durationMinutes: 45,
      windowPreset: "tomorrow_morning",
      idempotencyKey: "owner-editor-preset-duration-1",
    });
    const payload = executedApprovals[0]?.payload;
    expect(payload).toMatchObject({
      action: "schedule_event",
      timeZone: "America/Los_Angeles",
      durationMinutes: 45,
      windowPreset: "tomorrow_morning",
    });
    if (payload?.action !== "schedule_event") {
      throw new Error("schedule approval payload missing");
    }
    expect(payload.endsAtMs - payload.startsAtMs).toBe(45 * 60 * 1000);
  });

  it("recovers a same-hash pending row after restart before touching the provider", async () => {
    const queue = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    let simulateCrash = true;
    const crashAfterPending = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "enqueueConfirmed") {
          return async (
            input: Parameters<ApprovalQueue["enqueueConfirmed"]>[0],
          ) => {
            if (!simulateCrash) {
              return target.enqueueConfirmed(input, {
                resolvedBy: String(runtime.agentId),
                resolutionReason: "recovered",
              });
            }
            simulateCrash = false;
            await target.enqueue(input);
            throw new Error("simulated restart after pending insert");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ApprovalQueue;
    const request = {
      ...createRequest,
      idempotencyKey: "owner-editor-pending-recovery-1",
    };
    await expect(
      new OwnerCalendarMutationGatewayService(
        runtime,
        deps(readablePort(), crashAfterPending),
      ).create(new URL("http://internal.local"), request),
    ).rejects.toThrow("simulated restart after pending insert");
    expect(providerCalls).toBe(0);

    await new OwnerCalendarMutationGatewayService(
      runtime,
      deps(readablePort(), queue),
    ).create(new URL("http://internal.local"), request);
    expect(providerCalls).toBe(1);
  });

  it("recovers a pending update approval without rebuilding it from mutable provider state", async () => {
    storedEvent = event();
    const queue = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    let simulateCrash = true;
    const crashAfterPending = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "enqueueConfirmed") {
          return async (
            input: Parameters<ApprovalQueue["enqueueConfirmed"]>[0],
          ) => {
            if (!simulateCrash) {
              return target.enqueueConfirmed(input, {
                resolvedBy: String(runtime.agentId),
                resolutionReason: "recovered",
              });
            }
            simulateCrash = false;
            await target.enqueue(input);
            throw new Error("simulated update restart after pending insert");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ApprovalQueue;
    const updatedEvent = {
      ...event(),
      title: "Recovered update",
      metadata: { etag: '"updated-v2"' },
    };
    const updatePort: CalendarMutationPort = {
      async preflight() {
        return {
          operation: "modify_event",
          provider: "google",
          sourceId: "google-calendar-owner-grant",
          calendarId: "primary",
          event: storedEvent,
          providerEventId: "provider-created-1",
          providerVersion: '"created-v1"',
          idempotencyKey: null,
          recurrenceScope: null,
          cancellationMode: null,
        };
      },
      async execute() {
        providerCalls += 1;
        storedEvent = updatedEvent;
        return readableReceipt(updatedEvent, {
          operation: "modify_event",
          providerVersion: '"updated-v2"',
        });
      },
    };
    const request = {
      side: "owner" as const,
      grantId: "google-calendar-owner-grant",
      calendarId: "primary",
      eventId: "provider-created-1",
      title: "Recovered update",
      expectedProviderVersion: '"created-v1"',
      idempotencyKey: "owner-editor-pending-update-recovery-1",
      notifyAttendees: false,
    };
    await expect(
      new OwnerCalendarMutationGatewayService(
        runtime,
        deps(updatePort, crashAfterPending),
      ).update(new URL("http://internal.local"), request),
    ).rejects.toThrow("simulated update restart after pending insert");
    expect(providerCalls).toBe(0);

    storedEvent = null;
    await expect(
      new OwnerCalendarMutationGatewayService(
        runtime,
        deps(updatePort, queue),
      ).update(new URL("http://internal.local"), request),
    ).resolves.toMatchObject({ title: "Recovered update" });
    expect(providerCalls).toBe(1);
  });

  it("handles a runtime-queue idempotency race without crossing the provider boundary twice", async () => {
    const port = readablePort();
    const queue = createApprovalQueue(runtime, {
      agentId: runtime.agentId,
    });
    const operationKey = "owner-editor-runtime-race-1";
    await new OwnerCalendarMutationGatewayService(
      runtime,
      deps(port, queue),
    ).create(new URL("http://internal.local"), {
      ...createRequest,
      idempotencyKey: operationKey,
    });

    let hideFirstLookup = true;
    const racingQueue = new Proxy(queue, {
      get(target, property, receiver) {
        if (property === "byIdempotencyKey") {
          return async (idempotencyKey: string) => {
            if (hideFirstLookup) {
              hideFirstLookup = false;
              return null;
            }
            return target.byIdempotencyKey(idempotencyKey);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ApprovalQueue;
    const racedGateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(port, racingQueue),
    );

    await expect(
      racedGateway.create(new URL("http://internal.local"), {
        ...createRequest,
        title: "Different event",
        idempotencyKey: operationKey,
      }),
    ).rejects.toMatchObject({
      code: "CALENDAR_EDITOR_IDEMPOTENCY_CONFLICT",
    });
    expect(providerCalls).toBe(1);
  });

  it("persists Apple add-only acceptance without inventing an event id", async () => {
    const applePort: CalendarMutationPort = {
      async preflight() {
        return {
          operation: "schedule_event",
          provider: "apple_calendar",
          sourceId: "apple-calendar",
          calendarId: "primary",
          event: null,
          providerEventId: null,
          providerVersion: null,
          idempotencyKey: "apple-owner-editor-1",
          recurrenceScope: null,
          cancellationMode: null,
        };
      },
      async execute() {
        providerCalls += 1;
        return {
          operation: "schedule_event",
          provider: "apple_calendar",
          sourceId: "apple-calendar",
          calendarId: "primary",
          eventId: null,
          providerEventId: null,
          providerVersion: null,
          readBackAvailable: false,
          accessLevel: "write_only",
          eventSnapshot: null,
          recurrenceScope: null,
          cancellationMode: null,
          acceptedAt: "2027-03-01T00:00:00.000Z",
        };
      },
    };
    const gateway = new OwnerCalendarMutationGatewayService(
      runtime,
      deps(applePort),
    );
    const result = await gateway.create(new URL("http://internal.local"), {
      ...createRequest,
      grantId: "apple-calendar",
      idempotencyKey: "owner-editor-apple-write-only-1",
    });
    expect(result).toEqual({
      outcome: "accepted_without_readback",
      event: null,
      writeOnlyReceipt: {
        provider: "apple_calendar",
        sourceId: "apple-calendar",
        calendarId: "primary",
        accessLevel: "write_only",
        destination: "default_calendar",
        providerEventId: null,
        readBackAvailable: false,
        acceptedAt: "2027-03-01T00:00:00.000Z",
      },
    });
    expect(providerCalls).toBe(1);
  });
});
