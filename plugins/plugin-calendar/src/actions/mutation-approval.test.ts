import type {
  ApprovalEnqueueInput,
  ApprovalEnqueueResult,
} from "@elizaos/plugin-assistant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ owner: true, role: vi.fn() }));
vi.mock("@elizaos/core", () => ({
  hasRoleAccess: (...args: unknown[]) => {
    controls.role(...args);
    return Promise.resolve(controls.owner);
  },
  stableStringify: (v: unknown) => JSON.stringify(v),
  toWellFormedUnicode: (v: string) => v,
}));
vi.mock("@elizaos/plugin-assistant", () => ({
  createApprovalQueue: () => {
    throw Error("Inject the owning queue");
  },
  buildApprovalChoiceText: ({
    requestId,
    reason,
  }: {
    requestId: string;
    reason: string;
  }) => `${reason}\napprove ${requestId}=Approve`,
}));
vi.mock("../internal/errors.js", () => ({
  CalendarServiceError: class extends Error {
    constructor(status: number, message: string, code: string) {
      super(message);
      Object.assign(this, { status, code });
    }
  },
}));
vi.mock("../internal/detail.js", () => ({
  INTERNAL_URL: new URL("http://127.0.0.1"),
}));
vi.mock("../internal/eliza-calendar.js", () => ({
  isElizaCalendarGrant: () => false,
}));
vi.mock("../service/CalendarService.js", () => ({
  CalendarService: { serviceType: "calendar" },
}));
vi.mock("../apple-calendar.js", () => ({ isAppleCalendarGrant: () => false }));
vi.mock("../microsoft/accounts.js", () => ({
  isMicrosoftCalendarGrantId: () => false,
}));

import { createCalendarMutationApprovalGateway } from "./mutation-approval.js";

type ScheduleArgs = Parameters<
  ReturnType<typeof createCalendarMutationApprovalGateway>["schedule"]
>[0];
describe("standalone Calendar owner approval", () => {
  beforeEach(() => {
    controls.owner = true;
    controls.role.mockClear();
  });
  const runtime = {
    agentId: "agent",
    getService: () => null,
  } as ScheduleArgs["runtime"];
  const message = {
    id: "message-1",
    entityId: "owner",
    agentId: "agent",
    createdAt: Date.now(),
  } as ScheduleArgs["message"];
  const request = {
    grantId: "google-owner-grant",
    side: "owner",
    calendarId: "primary",
    title: "Private fixture",
    startAt: "2026-10-14T18:00:00Z",
    endAt: "2026-10-14T18:02:00Z",
    notifyAttendees: false,
  } as ScheduleArgs["request"];
  function setup() {
    const enqueue = vi.fn(
      async (input: ApprovalEnqueueInput) =>
        ({
          reused: false,
          request: {
            ...input,
            id: "approval-1",
            state: "pending",
            createdAt: new Date(),
          },
        }) as ApprovalEnqueueResult,
    );
    return {
      enqueue,
      gateway: createCalendarMutationApprovalGateway({
        createQueue: () => ({ enqueueWithResult: enqueue }),
      }),
    };
  }
  it("persists a review tied to the actual message and exact payload without a provider effect", async () => {
    const { enqueue, gateway } = setup();
    const first = await gateway.schedule({ runtime, message, request });
    const again = await gateway.schedule({ runtime, message, request });
    expect(first.requestId).toBe("approval-1");
    expect(first.idempotencyKey).toBe(again.idempotencyKey);
    expect(first.text).toContain("approve approval-1");
    expect(controls.role).toHaveBeenCalledWith(runtime, message, "OWNER");
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      subjectUserId: "owner",
      action: "schedule_event",
      payload: { calendarId: "primary", notifyAttendees: false },
    });
  });
  it("refuses nonowners before inserting a request", async () => {
    controls.owner = false;
    const { enqueue, gateway } = setup();
    await expect(
      gateway.schedule({ runtime, message, request }),
    ).rejects.toThrow("current owner");
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("refuses a foreign agent even for an owner", async () => {
    const { enqueue, gateway } = setup();
    await expect(
      gateway.schedule({
        runtime,
        message: { ...message, agentId: "other" },
        request,
      }),
    ).rejects.toThrow("current owner");
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("requires persisted message identity", async () => {
    const { enqueue, gateway } = setup();
    await expect(
      gateway.schedule({
        runtime,
        message: { ...message, id: undefined },
        request,
      }),
    ).rejects.toThrow("persisted source message");
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("refuses a review with a non-finite creation time", async () => {
    const { enqueue, gateway } = setup();
    await expect(
      gateway.schedule({
        runtime,
        message: { ...message, createdAt: NaN },
        request,
      }),
    ).rejects.toThrow("persisted source message");
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("uses a different review identity if event content changes", async () => {
    const { gateway } = setup();
    const a = await gateway.schedule({ runtime, message, request });
    const b = await gateway.schedule({
      runtime,
      message,
      request: { ...request, title: "Changed" },
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
  describe("recurring series scope in the owner's approval text", () => {
    const targetEvent = {
      id: "google-owner-grant:event-1",
      externalId: "event-1",
      grantId: "google-owner-grant",
      calendarId: "primary",
      provider: "google",
      side: "owner",
      title: "Standup",
      startAt: "2026-10-14T18:00:00Z",
      endAt: "2026-10-14T18:15:00Z",
      updatedAt: "2026-10-14T17:00:00Z",
      organizer: { self: true },
      attendees: [],
      recurringEventId: "series-1",
      metadata: { etag: '"v1"', recurringEventId: "series-1" },
    } as unknown as Parameters<
      ReturnType<typeof createCalendarMutationApprovalGateway>["cancel"]
    >[0]["targetEvent"];
    it("tells the owner a series cancel removes every occurrence", async () => {
      const { enqueue, gateway } = setup();
      await gateway.cancel({
        runtime,
        message,
        request: {
          grantId: "google-owner-grant",
          side: "owner",
          calendarId: "primary",
          eventId: "event-1",
          recurrenceScope: "series",
          notifyAttendees: false,
        } as never,
        targetEvent,
      });
      const reason = String(enqueue.mock.calls[0][0].reason);
      expect(reason).toMatch(/every occurrence|whole recurring series/i);
      expect(reason).not.toMatch(/ on 2026-10-14T18:00:00/);
    });
    it("tells the owner a series modify changes every occurrence", async () => {
      const { enqueue, gateway } = setup();
      await gateway.modify({
        runtime,
        message,
        request: {
          grantId: "google-owner-grant",
          side: "owner",
          calendarId: "primary",
          eventId: "event-1",
          recurrenceScope: "series",
          notifyAttendees: false,
          title: "Daily sync",
        } as never,
        targetEvent,
      });
      const reason = String(enqueue.mock.calls[0][0].reason);
      expect(reason).toMatch(/every occurrence|whole recurring series/i);
      expect(reason).not.toMatch(/ on 2026-10-14T18:00:00/);
    });
  });

  describe("managed Google Calendar deletion", () => {
    const managedGrant = `alpha-google:${"c".repeat(64)}`;
    const targetEvent = {
      id: `${managedGrant}:event-1`,
      externalId: "event-1",
      grantId: managedGrant,
      calendarId: "primary",
      provider: "google",
      side: "owner",
      title: "Private fixture",
      startAt: "2026-10-14T18:00:00Z",
      endAt: "2026-10-14T18:02:00Z",
      updatedAt: "2026-10-14T17:00:00Z",
      organizer: { self: true },
      attendees: [],
      metadata: { etag: '"v1"' },
    } as unknown as Parameters<
      ReturnType<typeof createCalendarMutationApprovalGateway>["cancel"]
    >[0]["targetEvent"];
    const cancelRequest = {
      grantId: managedGrant,
      side: "owner",
      calendarId: "primary",
      eventId: "event-1",
      notifyAttendees: false,
    } as never;
    afterEach(() => vi.unstubAllEnvs());
    it("refuses before asking the owner when deletion is not enabled", async () => {
      vi.stubEnv("ELIZA_MANAGED_CALENDAR_DELETE_ENABLED", "");
      const { enqueue, gateway } = setup();
      await expect(
        gateway.cancel({
          runtime,
          message,
          request: cancelRequest,
          targetEvent,
        }),
      ).rejects.toMatchObject({ code: "CALENDAR_MANAGED_DELETE_UNAVAILABLE" });
      expect(enqueue).not.toHaveBeenCalled();
    });
    it("still queues an owner review, and refuses nonowners, when deletion is enabled", async () => {
      vi.stubEnv("ELIZA_MANAGED_CALENDAR_DELETE_ENABLED", "1");
      const { enqueue, gateway } = setup();
      const review = await gateway.cancel({
        runtime,
        message,
        request: cancelRequest,
        targetEvent,
      });
      expect(review.requestId).toBe("approval-1");
      expect(enqueue.mock.calls[0][0]).toMatchObject({
        subjectUserId: "owner",
        action: "cancel_event",
        payload: { grantId: managedGrant, eventId: "event-1" },
      });
      expect(controls.role).toHaveBeenCalledWith(runtime, message, "OWNER");
      controls.owner = false;
      await expect(
        gateway.cancel({
          runtime,
          message,
          request: cancelRequest,
          targetEvent,
        }),
      ).rejects.toThrow("current owner");
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });
});
