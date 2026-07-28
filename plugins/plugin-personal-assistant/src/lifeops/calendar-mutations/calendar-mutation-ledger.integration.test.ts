/**
 * Real-PGlite and loopback-HTTP proof for exactly-once calendar mutation
 * claims, provider receipts, replay suppression, and ambiguous crash recovery.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { CalendarServiceError } from "@elizaos/plugin-calendar";
import type {
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  ListLifeOpsCalendarsRequest,
} from "@elizaos/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import type {
  ApprovalEnqueueInput,
  ApprovalPayload,
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import { executeCalendarMutationApproval } from "./execution.js";
import { CalendarMutationLedger } from "./ledger.js";
import {
  type CalendarMutationService,
  createLifeOpsCalendarMutationPort,
} from "./lifeops-port.js";

type ProviderMode =
  | "success"
  | "hold_before_accept"
  | "reject_before_accept"
  | "accept_then_disconnect";

const ownerCalendar: LifeOpsCalendarSummary = {
  provider: "google",
  side: "owner",
  grantId: "google-calendar-owner-grant",
  connectorAccountId: "owner-account",
  accountEmail: "owner@example.com",
  calendarId: "primary",
  summary: "Owner",
  description: null,
  primary: true,
  accessRole: "owner",
  backgroundColor: null,
  foregroundColor: null,
  timeZone: "America/Los_Angeles",
  selected: true,
  includeInFeed: true,
};

let fixtureAgentId = "calendar-test-agent";

function calendarEvent(
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  return {
    id: "calendar-row-event-1",
    externalId: "provider-event-1",
    agentId: fixtureAgentId,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "School pickup",
    description: "Pickup plan",
    location: "School",
    status: "confirmed",
    startAt: "2027-03-12T23:00:00.000Z",
    endAt: "2027-03-13T00:00:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer: { email: "owner@example.com", self: true },
    attendees: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        self: true,
        organizer: true,
        optional: false,
      },
    ],
    metadata: { etag: '"event-version-1"' },
    connectorAccountId: "owner-account",
    grantId: ownerCalendar.grantId,
    accountEmail: ownerCalendar.accountEmail ?? undefined,
    syncedAt: "2027-03-01T12:00:00.000Z",
    updatedAt: "2027-03-01T12:00:00.000Z",
    ...overrides,
  };
}

function calendarFeed(
  calendars: readonly LifeOpsCalendarSummary[],
  events: readonly LifeOpsCalendarEvent[],
): LifeOpsCalendarFeed {
  const calendar = calendars[0] ?? ownerCalendar;
  return {
    calendarId: calendar.calendarId,
    events: [...events],
    source: "synced",
    state: "complete",
    sources: calendars.map((source) => ({
      key: {
        provider: source.provider,
        side: source.side,
        grantId: source.grantId,
        connectorAccountId: source.connectorAccountId,
        calendarId: source.calendarId,
      },
      summary: source.summary,
      accessRole: source.accessRole,
      visibility: "details",
      status: "fresh",
      syncedAt: "2027-03-01T12:00:00.000Z",
      error: null,
    })),
    timeMin: "2027-03-10T00:00:00.000Z",
    timeMax: "2027-03-15T00:00:00.000Z",
    syncedAt: "2027-03-01T12:00:00.000Z",
  };
}

describe("calendar mutation ledger — real PGlite and HTTP provider", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let approvals: ApprovalQueue;
  let server: http.Server;
  let baseUrl: string;
  let providerMode: ProviderMode;
  let calendars: LifeOpsCalendarSummary[];
  let events: Map<string, LifeOpsCalendarEvent>;
  let mutationRequests: Array<{
    method: string;
    path: string;
    body: Record<string, unknown>;
  }>;
  let travelReservations: Array<{
    eventId: string;
    bufferMinutes: number;
    method: string;
  }>;
  let releaseProvider: (() => void) | null;
  let providerObserved: Promise<void>;
  let markProviderObserved: (() => void) | null;

  function resetProviderObservation(): void {
    providerObserved = new Promise<void>((resolve) => {
      markProviderObserved = resolve;
    });
  }

  async function readBody(
    request: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("provider request body must be an object");
    }
    return parsed as Record<string, unknown>;
  }

  function json(
    response: http.ServerResponse,
    status: number,
    value: unknown,
  ): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }

  async function waitForProviderRelease(): Promise<void> {
    if (providerMode !== "hold_before_accept") return;
    await new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
  }

  function applyMutation(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): LifeOpsCalendarEvent | null {
    if (method === "POST" && path === "/events") {
      const sequence = mutationRequests.length;
      const event = calendarEvent({
        id: `calendar-row-created-${sequence}`,
        externalId: `provider-created-${sequence}`,
        title: String(body.title),
        description:
          typeof body.description === "string" ? body.description : "",
        location: typeof body.location === "string" ? body.location : "",
        startAt: String(body.startAt),
        endAt: String(body.endAt),
        metadata: { etag: `"create-version-${sequence}"` },
        updatedAt: `2027-03-01T12:00:0${sequence}.000Z`,
      });
      events.set(event.externalId, event);
      return event;
    }
    const eventId = decodeURIComponent(path.slice("/events/".length));
    const current = events.get(eventId);
    if (!current) return null;
    if (method === "PATCH") {
      const sequence = mutationRequests.length;
      const updated = {
        ...current,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.startAt === "string" ? { startAt: body.startAt } : {}),
        ...(typeof body.endAt === "string" ? { endAt: body.endAt } : {}),
        ...(body.responseStatus === "declined"
          ? {
              attendees: current.attendees.map((attendee) =>
                attendee.self
                  ? { ...attendee, responseStatus: "declined" }
                  : attendee,
              ),
            }
          : {}),
        metadata: { etag: `"update-version-${sequence}"` },
        updatedAt: `2027-03-01T12:01:0${sequence}.000Z`,
      };
      events.set(eventId, updated);
      return updated;
    }
    if (method === "DELETE") {
      events.delete(eventId);
      return current;
    }
    return null;
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    fixtureAgentId = String(runtime.agentId);
    approvals = createApprovalQueue(runtime, { agentId: runtime.agentId });

    server = http.createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://loopback.invalid");
        if (request.method === "GET" && url.pathname === "/calendars") {
          json(response, 200, calendars);
          return;
        }
        if (request.method === "GET" && url.pathname === "/feed") {
          json(response, 200, calendarFeed(calendars, [...events.values()]));
          return;
        }
        if (request.method === "GET" && url.pathname.startsWith("/events/")) {
          const eventId = decodeURIComponent(
            url.pathname.slice("/events/".length),
          );
          const event = events.get(eventId);
          if (!event) {
            json(response, 404, {
              code: "PROVIDER_EVENT_NOT_FOUND",
              message: "provider event missing",
            });
            return;
          }
          json(response, 200, { event });
          return;
        }
        const method = request.method ?? "";
        if (
          !["POST", "PATCH", "DELETE"].includes(method) ||
          !url.pathname.startsWith("/events")
        ) {
          json(response, 404, { code: "NOT_FOUND" });
          return;
        }
        const body = await readBody(request);
        mutationRequests.push({ method, path: url.pathname, body });
        markProviderObserved?.();
        if (providerMode === "reject_before_accept") {
          json(response, 503, {
            code: "PROVIDER_NOT_ACCEPTED",
            message: "sandbox rejected before acceptance",
          });
          return;
        }
        if (method !== "POST") {
          const eventId = decodeURIComponent(
            url.pathname.slice("/events/".length),
          );
          const current = events.get(eventId);
          const conditionalTarget =
            body.recurrenceScope === "this_and_following" &&
            current?.recurringEventId
              ? events.get(current.recurringEventId)
              : current;
          const etag = conditionalTarget?.metadata.etag;
          if (
            typeof body.expectedProviderVersion === "string" &&
            body.expectedProviderVersion !== etag
          ) {
            json(response, 409, {
              code: "PROVIDER_PRECONDITION_FAILED",
              message: "sandbox event changed before conditional write",
            });
            return;
          }
          if (
            typeof body.expectedOccurrenceProviderVersion === "string" &&
            body.expectedOccurrenceProviderVersion !== current?.metadata.etag
          ) {
            json(response, 409, {
              code: "PROVIDER_PRECONDITION_FAILED",
              message: "sandbox occurrence changed before conditional write",
            });
            return;
          }
        }
        await waitForProviderRelease();
        const event = applyMutation(method, url.pathname, body);
        if (!event) {
          json(response, 404, {
            code: "PROVIDER_EVENT_NOT_FOUND",
            message: "provider event missing",
          });
          return;
        }
        if (providerMode === "accept_then_disconnect") {
          response.socket?.destroy();
          return;
        }
        json(response, 200, { event });
      })().catch((error) => {
        json(response, 500, {
          code: "SANDBOX_HANDLER_FAILURE",
          message: error instanceof Error ? error.message : "unknown",
        });
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("loopback calendar provider failed to listen");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  afterAll(async () => {
    server.close();
    await once(server, "close");
    await runtimeResult?.cleanup();
  });

  beforeEach(() => {
    providerMode = "success";
    calendars = [{ ...ownerCalendar }];
    events = new Map([["provider-event-1", calendarEvent()]]);
    mutationRequests = [];
    travelReservations = [];
    releaseProvider = null;
    resetProviderObservation();
  });

  async function providerJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const body = (await response.json()) as {
      code?: string;
      message?: string;
    } & T;
    if (!response.ok) {
      throw new CalendarServiceError(
        response.status,
        body.message ?? "sandbox provider rejected request",
        body.code,
      );
    }
    return body;
  }

  function loopbackService(): CalendarMutationService {
    return {
      async listCalendars(
        _requestUrl: URL,
        _request?: ListLifeOpsCalendarsRequest,
      ) {
        return providerJson<LifeOpsCalendarSummary[]>("/calendars");
      },
      async getCalendarFeed(
        _requestUrl: URL,
        _request?: GetLifeOpsCalendarFeedRequest,
      ) {
        return providerJson<LifeOpsCalendarFeed>("/feed");
      },
      async createCalendarEvent(_requestUrl, request) {
        const result = await providerJson<{ event: LifeOpsCalendarEvent }>(
          "/events",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return result.event;
      },
      async createCalendarEventMutation(_requestUrl, request) {
        const result = await providerJson<{ event: LifeOpsCalendarEvent }>(
          "/events",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return {
          outcome: "event" as const,
          event: result.event,
          writeOnlyReceipt: null,
        };
      },
      async getAppleCalendarCreateAccess() {
        throw new Error("Apple Calendar is not configured in this fixture.");
      },
      async updateCalendarEvent(_requestUrl, request) {
        const result = await providerJson<{ event: LifeOpsCalendarEvent }>(
          `/events/${encodeURIComponent(request.eventId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return result.event;
      },
      async deleteCalendarEvent(_requestUrl, request) {
        await providerJson<{ event: LifeOpsCalendarEvent }>(
          `/events/${encodeURIComponent(request.eventId)}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
      },
      async getConditionalCalendarMutationTarget(_requestUrl, request) {
        const selected = events.get(request.eventId);
        const targetEventId =
          (request.recurrenceScope === "series" ||
            request.recurrenceScope === "this_and_following") &&
          selected?.recurringEventId
            ? selected.recurringEventId
            : request.eventId;
        const result = await providerJson<{ event: LifeOpsCalendarEvent }>(
          `/events/${encodeURIComponent(targetEventId)}`,
        );
        return result.event;
      },
      async respondToCalendarEvent(_requestUrl, request) {
        const result = await providerJson<{ event: LifeOpsCalendarEvent }>(
          `/events/${encodeURIComponent(request.eventId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
        );
        return result.event;
      },
      async reserveTravelBuffer(request) {
        travelReservations.push(request);
        const event = [...events.values()].find(
          (candidate) => candidate.id === request.eventId,
        );
        if (!event) throw new Error("travel reservation parent missing");
        return event;
      },
    };
  }

  function port() {
    return createLifeOpsCalendarMutationPort(runtime, loopbackService());
  }

  async function approved(payload: ApprovalPayload): Promise<ApprovalRequest> {
    const input: ApprovalEnqueueInput = {
      requestedBy: "calendar-mutation-integration",
      subjectUserId: String(runtime.agentId),
      action: payload.action,
      payload,
      channel: "google_calendar",
      reason: `Execute exact ${payload.action} payload`,
      idempotencyKey: `calendar-mutation-test:${randomUUID()}`,
      expiresAt: new Date("2027-03-31T00:00:00.000Z"),
    };
    const pending = await approvals.enqueue(input);
    return approvals.approve(pending.id, {
      resolvedBy: String(runtime.agentId),
      resolutionReason: "Owner reviewed exact provider-bound payload.",
    });
  }

  function createPayload(
    overrides: Partial<
      Extract<ApprovalPayload, { action: "schedule_event" }>
    > = {},
  ): Extract<ApprovalPayload, { action: "schedule_event" }> {
    return {
      action: "schedule_event",
      calendarId: ownerCalendar.calendarId,
      grantId: ownerCalendar.grantId,
      side: "owner",
      title: "Create pickup hold",
      startsAtMs: Date.parse("2027-03-14T18:00:00.000Z"),
      endsAtMs: Date.parse("2027-03-14T18:30:00.000Z"),
      attendees: ["coparent@example.com"],
      location: "School",
      description: "Provider sandbox create",
      notifyAttendees: false,
      ...overrides,
    };
  }

  function modifyPayload(
    event: LifeOpsCalendarEvent,
    recurrenceScope: "instance" | "this_and_following" | "series" = "instance",
  ): Extract<ApprovalPayload, { action: "modify_event" }> {
    return {
      action: "modify_event",
      calendarId: event.calendarId,
      eventId: event.externalId,
      grantId: event.grantId,
      side: "owner",
      expectedProvider: event.provider,
      expectedProviderVersion: String(event.metadata.etag),
      expectedEventUpdatedAt: event.updatedAt,
      expectedEventStartAtMs: Date.parse(event.startAt),
      recurrenceScope,
      notifyAttendees: false,
      patch: {
        title: "Updated pickup",
        startsAtMs: null,
        endsAtMs: null,
        attendees: null,
        location: null,
        description: null,
      },
    };
  }

  function cancelPayload(
    event: LifeOpsCalendarEvent,
    input: {
      mode?: "organizer_cancel" | "remove_private_copy";
      recurrenceScope?: "instance" | "this_and_following" | "series";
    } = {},
  ): Extract<ApprovalPayload, { action: "cancel_event" }> {
    return {
      action: "cancel_event",
      calendarId: event.calendarId,
      eventId: event.externalId,
      grantId: event.grantId,
      side: "owner",
      expectedProvider: event.provider,
      expectedProviderVersion: String(event.metadata.etag),
      expectedEventUpdatedAt: event.updatedAt,
      expectedEventStartAtMs: Date.parse(event.startAt),
      recurrenceScope: input.recurrenceScope ?? "instance",
      cancellationMode: input.mode ?? "organizer_cancel",
      notifyAttendees: false,
    };
  }

  it("persists source-bound create, update, and cancel receipts with recurrence scopes", async () => {
    const createRequest = await approved(
      createPayload({
        travelBuffer: {
          bufferMinutes: 25,
          method: "maps-api",
          originAddress: "Home",
          destinationAddress: "School",
        },
      }),
    );
    const created = await executeCalendarMutationApproval({
      runtime,
      request: createRequest,
      port: port(),
    });
    expect(created).toMatchObject({
      kind: "succeeded",
      duplicateSuppressed: false,
      receipt: {
        operation: "schedule_event",
        provider: "google",
        sourceId: ownerCalendar.grantId,
        calendarId: ownerCalendar.calendarId,
        providerVersion: '"create-version-1"',
      },
    });
    expect(travelReservations).toEqual([
      {
        eventId: expect.any(String),
        bufferMinutes: 25,
        method: "maps-api",
      },
    ]);

    const existing = events.get("provider-event-1");
    if (!existing) throw new Error("update fixture missing");
    const modifyRequest = await approved(modifyPayload(existing, "instance"));
    const modified = await executeCalendarMutationApproval({
      runtime,
      request: modifyRequest,
      port: port(),
    });
    expect(modified).toMatchObject({
      kind: "succeeded",
      receipt: {
        operation: "modify_event",
        providerEventId: existing.externalId,
        recurrenceScope: "instance",
        providerVersion: '"update-version-2"',
      },
    });
    expect(mutationRequests.at(-1)?.body.recurrenceScope).toBe("instance");

    const updated = events.get("provider-event-1");
    if (!updated) throw new Error("cancel fixture missing");
    const cancelRequest = await approved(
      cancelPayload(updated, { recurrenceScope: "series" }),
    );
    const cancelled = await executeCalendarMutationApproval({
      runtime,
      request: cancelRequest,
      port: port(),
    });
    expect(cancelled).toMatchObject({
      kind: "succeeded",
      receipt: {
        operation: "cancel_event",
        providerEventId: existing.externalId,
        recurrenceScope: "series",
        cancellationMode: "organizer_cancel",
      },
    });
    expect(mutationRequests.at(-1)?.body.recurrenceScope).toBe("series");
    expect(events.has("provider-event-1")).toBe(false);
    expect((await approvals.byId(cancelRequest.id))?.state).toBe("done");
  }, 60_000);

  it("binds both recurrence versions and suppresses replay of a following-series split", async () => {
    const series = calendarEvent({
      id: "calendar-row-series-1",
      externalId: "provider-series-1",
      title: "Weekly school pickup",
      startAt: "2027-02-26T23:00:00.000Z",
      endAt: "2027-02-27T00:00:00.000Z",
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"],
      recurringEventId: null,
      metadata: { etag: '"series-version-1"' },
      updatedAt: "2027-03-01T11:00:00.000Z",
    });
    const occurrence = calendarEvent({
      id: "calendar-row-occurrence-3",
      externalId: "provider-occurrence-3",
      title: series.title,
      recurringEventId: series.externalId,
      recurrence: null,
      metadata: {
        etag: '"occurrence-version-3"',
        recurringEventId: series.externalId,
        originalStartTime: "2027-03-12T23:00:00.000Z",
        originalStartIsAllDay: false,
      },
      updatedAt: "2027-03-01T12:00:00.000Z",
    });
    events = new Map([
      [series.externalId, series],
      [occurrence.externalId, occurrence],
    ]);
    const request = await approved({
      ...modifyPayload(occurrence, "this_and_following"),
      seriesMaster: {
        externalId: series.externalId,
        startAtMs: Date.parse(series.startAt),
        updatedAt: series.updatedAt,
        etag: String(series.metadata.etag),
      },
    });

    const completed = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(completed).toMatchObject({
      kind: "succeeded",
      duplicateSuppressed: false,
      receipt: {
        operation: "modify_event",
        recurrenceScope: "this_and_following",
      },
    });
    expect(mutationRequests).toHaveLength(1);
    expect(mutationRequests[0]).toMatchObject({
      method: "PATCH",
      path: `/events/${occurrence.externalId}`,
      body: {
        recurrenceScope: "this_and_following",
        expectedProviderVersion: '"series-version-1"',
        expectedOccurrenceProviderVersion: '"occurrence-version-3"',
        idempotencyKey: expect.any(String),
      },
    });
    const operationKey = mutationRequests[0]?.body.idempotencyKey;
    expect(typeof operationKey === "string" && operationKey.length > 0).toBe(
      true,
    );

    const replay = await executeCalendarMutationApproval({
      runtime,
      request: (await approvals.byId(request.id)) ?? request,
      port: port(),
    });
    expect(replay).toMatchObject({
      kind: "succeeded",
      duplicateSuppressed: true,
      receipt: { recurrenceScope: "this_and_following" },
    });
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("claims concurrently, sends one provider request, and suppresses receipt replay", async () => {
    providerMode = "hold_before_accept";
    const request = await approved(createPayload());
    const first = executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    await providerObserved;
    const duplicate = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(duplicate).toMatchObject({
      kind: "blocked",
      reason: "in_flight",
    });
    releaseProvider?.();
    const completed = await first;
    expect(completed.kind).toBe("succeeded");
    const replay = await executeCalendarMutationApproval({
      runtime,
      request: (await approvals.byId(request.id)) ?? request,
      port: port(),
    });
    expect(replay).toMatchObject({
      kind: "succeeded",
      duplicateSuppressed: true,
    });
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("quarantines a readable receipt whose event snapshot crosses the agent tenant", async () => {
    const request = await approved(createPayload());
    const realPort = port();
    const forgedPort = {
      preflight: realPort.preflight,
      async execute(
        approval: ApprovalRequest,
        preflight: Awaited<ReturnType<typeof realPort.preflight>>,
      ) {
        const receipt = await realPort.execute(approval, preflight);
        if (!receipt.eventSnapshot) {
          throw new Error("forged snapshot fixture requires readable receipt");
        }
        return {
          ...receipt,
          eventSnapshot: {
            ...receipt.eventSnapshot,
            agentId: "different-agent-tenant",
          },
        };
      },
    };
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: forgedPort,
    });
    expect(result).toMatchObject({
      kind: "blocked",
      reason: "ambiguous",
      attempt: {
        state: "ambiguous",
        receipt: null,
        lastFailure: {
          code: "CALENDAR_MUTATION_PROVIDER_RECEIPT_INVALID",
          retryable: false,
        },
      },
    });
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("retries only an explicit provider rejection before acceptance", async () => {
    providerMode = "reject_before_accept";
    const request = await approved(createPayload());
    const rejected = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(rejected).toMatchObject({
      kind: "retryable",
      phase: "provider",
      failure: {
        code: "PROVIDER_NOT_ACCEPTED",
        retryable: true,
      },
      attempt: { state: "failed_retryable", attemptCount: 1 },
    });
    expect((await approvals.byId(request.id))?.state).toBe("executing");

    providerMode = "success";
    const retried = await executeCalendarMutationApproval({
      runtime,
      request: (await approvals.byId(request.id)) ?? request,
      port: port(),
    });
    expect(retried).toMatchObject({
      kind: "succeeded",
      duplicateSuppressed: false,
      attempt: { attemptCount: 2 },
    });
    expect(mutationRequests).toHaveLength(2);
  }, 60_000);

  it("quarantines a disconnect after provider acceptance and never retries", async () => {
    providerMode = "accept_then_disconnect";
    const request = await approved(createPayload());
    const ambiguous = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(ambiguous).toMatchObject({
      kind: "blocked",
      reason: "ambiguous",
      attempt: {
        state: "ambiguous",
        lastFailure: {
          code: "CALENDAR_MUTATION_PROVIDER_OUTCOME_UNKNOWN",
          retryable: false,
        },
      },
    });
    expect((await approvals.byId(request.id))?.state).toBe("executing");
    expect(
      [...events.values()].some(
        (event) => event.title === "Create pickup hold",
      ),
    ).toBe(true);

    providerMode = "success";
    const replay = await executeCalendarMutationApproval({
      runtime,
      request: (await approvals.byId(request.id)) ?? request,
      port: port(),
    });
    expect(replay).toMatchObject({
      kind: "blocked",
      reason: "ambiguous",
    });
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("quarantines an orphaned executing claim after a runtime restart", async () => {
    const request = await approved(createPayload());
    const originalPort = port();
    const preflight = await originalPort.preflight(request);
    const ledger = new CalendarMutationLedger(runtime);
    const claim = await ledger.claim(request);
    if (claim.kind !== "claimed") throw new Error("claim fixture failed");
    await originalPort.execute(request, preflight);

    const restartedRuntime = Object.create(runtime) as IAgentRuntime;
    const restartedLedger = new CalendarMutationLedger(restartedRuntime);
    const recovered = await restartedLedger.inspect(request);
    expect(recovered).toMatchObject({
      kind: "blocked",
      reason: "ambiguous",
      attempt: {
        state: "ambiguous",
        lastFailure: {
          code: "CALENDAR_MUTATION_ORPHANED_EXECUTION",
          retryable: false,
        },
      },
    });
    const replay = await executeCalendarMutationApproval({
      runtime: restartedRuntime,
      request,
      port: originalPort,
    });
    expect(replay).toMatchObject({
      kind: "blocked",
      reason: "ambiguous",
    });
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("invalidates exact-target version drift before any provider mutation", async () => {
    const original = events.get("provider-event-1");
    if (!original) throw new Error("version fixture missing");
    const request = await approved(modifyPayload(original));
    events.set("provider-event-1", {
      ...original,
      title: "Changed outside approval",
      metadata: { etag: '"event-version-2"' },
      updatedAt: "2027-03-02T12:00:00.000Z",
    });
    const invalidated = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(invalidated).toMatchObject({
      kind: "invalidated",
      failure: {
        code: "CALENDAR_MUTATION_TARGET_CHANGED",
        retryable: false,
      },
    });
    expect((await approvals.byId(request.id))?.state).toBe("expired");
    expect(mutationRequests).toHaveLength(0);
  }, 60_000);

  it("rejects read-only sources before a create side effect", async () => {
    calendars = [{ ...ownerCalendar, accessRole: "reader" }];
    const request = await approved(createPayload());
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(result).toMatchObject({
      kind: "invalidated",
      failure: {
        code: "CALENDAR_MUTATION_SOURCE_READ_ONLY",
        retryable: false,
      },
    });
    expect(mutationRequests).toHaveLength(0);
  }, 60_000);

  it("resolves a full-access Apple default alias to the exact writable EventKit calendar", async () => {
    const appleCalendar: LifeOpsCalendarSummary = {
      ...ownerCalendar,
      provider: "apple_calendar",
      grantId: "apple-calendar",
      connectorAccountId: "apple-calendar",
      accountEmail: null,
      calendarId: "eventkit-default-calendar-id",
      summary: "Family",
      accessRole: "writer",
      primary: true,
    };
    let createRequest: Record<string, unknown> | null = null;
    const appleService: CalendarMutationService = {
      ...loopbackService(),
      async getAppleCalendarCreateAccess() {
        return {
          provider: "apple_calendar" as const,
          grantId: "apple-calendar" as const,
          accessLevel: "full_access" as const,
          readBackAvailable: true,
        };
      },
      async listCalendars() {
        return [appleCalendar];
      },
      async createCalendarEventMutation(_requestUrl, request) {
        createRequest = request;
        const created = calendarEvent({
          id: "apple-readable-row-1",
          externalId: "eventkit-event-1",
          provider: "apple_calendar",
          calendarId: appleCalendar.calendarId,
          grantId: appleCalendar.grantId,
          connectorAccountId: appleCalendar.connectorAccountId,
          accountEmail: undefined,
        });
        return {
          outcome: "event" as const,
          event: created,
          writeOnlyReceipt: null,
        };
      },
    };
    const request = await approved(
      createPayload({
        calendarId: "default",
        grantId: "apple-calendar",
        attendees: [],
      }),
    );
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: createLifeOpsCalendarMutationPort(runtime, appleService),
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      receipt: {
        provider: "apple_calendar",
        sourceId: "apple-calendar",
        calendarId: "eventkit-default-calendar-id",
        eventSnapshot: {
          calendarId: "eventkit-default-calendar-id",
        },
      },
    });
    expect(createRequest).toMatchObject({
      grantId: "apple-calendar",
      calendarId: "eventkit-default-calendar-id",
    });
  }, 60_000);

  it("canonicalizes Apple add-only aliases without listing or fabricating readable events", async () => {
    let listCalls = 0;
    let createRequest: Record<string, unknown> | null = null;
    const appleService: CalendarMutationService = {
      ...loopbackService(),
      async getAppleCalendarCreateAccess() {
        return {
          provider: "apple_calendar" as const,
          grantId: "apple-calendar" as const,
          accessLevel: "write_only" as const,
          readBackAvailable: false,
        };
      },
      async listCalendars() {
        listCalls += 1;
        return [];
      },
      async createCalendarEventMutation(_requestUrl, request) {
        createRequest = request;
        return {
          outcome: "accepted_without_readback" as const,
          event: null,
          writeOnlyReceipt: {
            provider: "apple_calendar" as const,
            sourceId: "apple-calendar",
            calendarId: "primary",
            accessLevel: "write_only" as const,
            destination: "default_calendar" as const,
            providerEventId: null,
            readBackAvailable: false as const,
            acceptedAt: "2027-03-01T00:00:00.000Z",
          },
        };
      },
    };
    const request = await approved(
      createPayload({
        calendarId: "default",
        grantId: "apple-calendar",
        attendees: [],
      }),
    );
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: createLifeOpsCalendarMutationPort(runtime, appleService),
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      receipt: {
        provider: "apple_calendar",
        sourceId: "apple-calendar",
        calendarId: "primary",
        eventId: null,
        providerEventId: null,
        eventSnapshot: null,
        accessLevel: "write_only",
        readBackAvailable: false,
      },
    });
    expect(listCalls).toBe(0);
    expect(createRequest).toMatchObject({
      grantId: "apple-calendar",
      calendarId: "primary",
    });
  }, 60_000);

  it.each([
    {
      label: "attendees",
      payload: { attendees: ["guest@example.com"] },
      code: "APPLE_CALENDAR_ATTENDEES_UNSUPPORTED",
    },
    {
      label: "recurrence",
      payload: { attendees: [], recurrence: ["RRULE:FREQ=WEEKLY"] },
      code: "APPLE_CALENDAR_RECURRENCE_UNSUPPORTED",
    },
  ])(
    "rejects unsupported Apple $label before any provider side effect",
    async ({ payload, code }) => {
      let createCalls = 0;
      const appleService: CalendarMutationService = {
        ...loopbackService(),
        async getAppleCalendarCreateAccess() {
          return {
            provider: "apple_calendar" as const,
            grantId: "apple-calendar" as const,
            accessLevel: "full_access" as const,
            readBackAvailable: true,
          };
        },
        async createCalendarEventMutation() {
          createCalls += 1;
          throw new Error("provider must not be reached");
        },
      };
      const request = await approved(
        createPayload({
          calendarId: "primary",
          grantId: "apple-calendar",
          ...payload,
        }),
      );
      const result = await executeCalendarMutationApproval({
        runtime,
        request,
        port: createLifeOpsCalendarMutationPort(runtime, appleService),
      });
      expect(result).toMatchObject({
        kind: "invalidated",
        failure: { code, retryable: false },
      });
      expect(createCalls).toBe(0);
    },
  );

  it("requires an exact grant when two accounts expose the same calendar id", async () => {
    calendars = [
      { ...ownerCalendar },
      {
        ...ownerCalendar,
        grantId: "google-calendar-second-grant",
        connectorAccountId: "second-account",
        accountEmail: "second@example.com",
      },
    ];
    const request = await approved(createPayload({ grantId: null }));
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(result).toMatchObject({
      kind: "invalidated",
      failure: {
        code: "CALENDAR_MUTATION_SOURCE_AMBIGUOUS",
        retryable: false,
      },
    });
    expect(mutationRequests).toHaveLength(0);
  }, 60_000);

  it("forbids organizer cancellation of an invitation", async () => {
    const invitation = calendarEvent({
      organizer: { email: "teacher@example.com", self: false },
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
    });
    events.set(invitation.externalId, invitation);
    const request = await approved(
      cancelPayload(invitation, { mode: "organizer_cancel" }),
    );
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(result).toMatchObject({
      kind: "invalidated",
      failure: {
        code: "CALENDAR_CANCELLATION_AUTHORITY_MISMATCH",
        retryable: false,
      },
    });
    expect(events.has(invitation.externalId)).toBe(true);
    expect(mutationRequests).toHaveLength(0);
  }, 60_000);

  it("removes an invitee's private copy without claiming organizer cancellation", async () => {
    const invitation = calendarEvent({
      organizer: { email: "teacher@example.com", self: false },
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
    });
    events.set(invitation.externalId, invitation);
    const request = await approved(
      cancelPayload(invitation, { mode: "remove_private_copy" }),
    );
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      receipt: {
        operation: "cancel_event",
        cancellationMode: "remove_private_copy",
      },
    });
    expect(events.has(invitation.externalId)).toBe(false);
  }, 60_000);

  it("declines an invitation with a conditional RSVP instead of deleting it", async () => {
    const invitation = calendarEvent({
      organizer: { email: "teacher@example.com", self: false },
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
    });
    events.set(invitation.externalId, invitation);
    const request = await approved({
      ...cancelPayload(invitation, { mode: "remove_private_copy" }),
      cancellationMode: "decline_invitation",
      notifyAttendees: true,
    });
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: port(),
    });
    expect(result).toMatchObject({
      kind: "succeeded",
      receipt: {
        operation: "cancel_event",
        cancellationMode: "decline_invitation",
      },
    });
    expect(events.has(invitation.externalId)).toBe(true);
    expect(
      events
        .get(invitation.externalId)
        ?.attendees.find((attendee) => attendee.self)?.responseStatus,
    ).toBe("declined");
    expect(mutationRequests.at(-1)?.body).toMatchObject({
      responseStatus: "declined",
      notifyAttendees: true,
      expectedProviderVersion: '"event-version-1"',
    });
  }, 60_000);

  it("invalidates a provider ETag race after claim without changing the event", async () => {
    const original = events.get("provider-event-1");
    if (!original) throw new Error("conditional-write fixture missing");
    const request = await approved(modifyPayload(original));
    const originalService = loopbackService();
    let changed = false;
    const racingService: CalendarMutationService = {
      ...originalService,
      async updateCalendarEvent(requestUrl, update) {
        if (!changed) {
          changed = true;
          events.set(original.externalId, {
            ...original,
            title: "Changed between preflight and write",
            metadata: { etag: '"event-version-raced"' },
          });
        }
        return originalService.updateCalendarEvent(requestUrl, update);
      },
    };
    const result = await executeCalendarMutationApproval({
      runtime,
      request,
      port: createLifeOpsCalendarMutationPort(runtime, racingService),
    });
    expect(result).toMatchObject({
      kind: "invalidated",
      failure: {
        code: "PROVIDER_PRECONDITION_FAILED",
        retryable: false,
      },
    });
    expect((await approvals.byId(request.id))?.state).toBe("expired");
    expect(events.get(original.externalId)?.title).toBe(
      "Changed between preflight and write",
    );
    expect(mutationRequests).toHaveLength(1);
  }, 60_000);

  it("binds execution input to the persisted approval before preflight", async () => {
    const request = await approved(createPayload());
    const altered: ApprovalRequest = {
      ...request,
      state: "approved",
      payload: createPayload({ title: "Altered after approval" }),
    };
    await expect(
      executeCalendarMutationApproval({
        runtime,
        request: altered,
        port: port(),
      }),
    ).rejects.toMatchObject({
      code: "CALENDAR_MUTATION_APPROVAL_CHANGED",
    });
    expect(
      await new CalendarMutationLedger(runtime).byApprovalRequestId(request.id),
    ).toBeNull();
    expect(mutationRequests).toHaveLength(0);
  }, 60_000);
});
