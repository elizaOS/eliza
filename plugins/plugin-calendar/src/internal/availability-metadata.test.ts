import { describe, expect, it } from "vitest";
import {
  availabilityReservationParentEventId,
  calendarAvailabilityKindFromMetadata,
  createCalendarAvailabilityReservation,
  isLocallyManagedAvailabilityEvent,
} from "./availability-metadata";

const baseParent = {
  id: "event-1",
  externalId: "ext-1",
  agentId: "agent-1",
  provider: "google",
  side: "primary",
  calendarId: "cal-1",
  timezone: "UTC",
  calendarSummary: "Work",
  connectorAccountId: "acct-1",
  grantId: "grant-1",
  accountEmail: "a@b.co",
  metadata: {},
};

describe("calendarAvailabilityKindFromMetadata", () => {
  it("returns the kind for known availability kinds", () => {
    expect(
      calendarAvailabilityKindFromMetadata({ availabilityKind: "travel" }),
    ).toBe("travel");
    expect(
      calendarAvailabilityKindFromMetadata({ availabilityKind: "hold" }),
    ).toBe("hold");
  });

  it("returns null for unknown, missing, or wrong-typed values", () => {
    expect(calendarAvailabilityKindFromMetadata({})).toBeNull();
    expect(
      calendarAvailabilityKindFromMetadata({ availabilityKind: "busy" }),
    ).toBeNull();
    expect(
      calendarAvailabilityKindFromMetadata({ availabilityKind: "TRAVEL" }),
    ).toBeNull();
    expect(
      calendarAvailabilityKindFromMetadata({ availabilityKind: 42 }),
    ).toBeNull();
  });
});

describe("isLocallyManagedAvailabilityEvent", () => {
  it("requires both the local flag and a recognized kind", () => {
    expect(
      isLocallyManagedAvailabilityEvent({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "travel",
        },
      }),
    ).toBe(true);
    expect(
      isLocallyManagedAvailabilityEvent({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "hold",
        },
      }),
    ).toBe(true);
  });

  it("returns false when the flag or kind is missing", () => {
    expect(isLocallyManagedAvailabilityEvent({ metadata: {} })).toBe(false);
    expect(
      isLocallyManagedAvailabilityEvent({
        metadata: { locallyManagedAvailability: true },
      }),
    ).toBe(false);
    expect(
      isLocallyManagedAvailabilityEvent({
        metadata: { availabilityKind: "travel" },
      }),
    ).toBe(false);
    expect(
      isLocallyManagedAvailabilityEvent({
        metadata: {
          locallyManagedAvailability: "true",
          availabilityKind: "travel",
        },
      }),
    ).toBe(false);
  });
});

describe("availabilityReservationParentEventId", () => {
  it("returns the parent id for a managed availability event with a non-empty id", () => {
    expect(
      availabilityReservationParentEventId({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "hold",
          parentEventId: "event-9",
        },
      }),
    ).toBe("event-9");
  });

  it("returns null for non-availability events and empty parent ids", () => {
    expect(
      availabilityReservationParentEventId({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "hold",
        },
      }),
    ).toBeNull();
    expect(
      availabilityReservationParentEventId({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "hold",
          parentEventId: "",
        },
      }),
    ).toBeNull();
    expect(
      availabilityReservationParentEventId({
        metadata: {
          locallyManagedAvailability: true,
          availabilityKind: "hold",
          parentEventId: 7,
        },
      }),
    ).toBeNull();
    expect(
      availabilityReservationParentEventId({
        metadata: { parentEventId: "event-9" },
      }),
    ).toBeNull();
  });
});

describe("createCalendarAvailabilityReservation", () => {
  it("rejects nesting an availability reservation under another reservation", () => {
    const parent = {
      ...baseParent,
      metadata: {
        locallyManagedAvailability: true,
        availabilityKind: "travel",
      },
    };
    expect(() =>
      createCalendarAvailabilityReservation({
        parent,
        kind: "hold",
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T11:00:00.000Z",
        idempotencyKey: "k1",
      }),
    ).toThrowError(/cannot own children/);
  });

  it("rejects non-finite or non-increasing time windows", () => {
    expect(() =>
      createCalendarAvailabilityReservation({
        parent: baseParent,
        kind: "travel",
        startAt: "not-a-date",
        endAt: "2026-01-01T11:00:00.000Z",
        idempotencyKey: "k1",
      }),
    ).toThrowError(/valid, increasing time window/);
    expect(() =>
      createCalendarAvailabilityReservation({
        parent: baseParent,
        kind: "travel",
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T09:00:00.000Z",
        idempotencyKey: "k1",
      }),
    ).toThrowError(/valid, increasing time window/);
    expect(() =>
      createCalendarAvailabilityReservation({
        parent: baseParent,
        kind: "travel",
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T10:00:00.000Z",
        idempotencyKey: "k1",
      }),
    ).toThrowError(/valid, increasing time window/);
  });

  it("rejects a blank idempotency key", () => {
    expect(() =>
      createCalendarAvailabilityReservation({
        parent: baseParent,
        kind: "travel",
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T11:00:00.000Z",
        idempotencyKey: "   ",
      }),
    ).toThrowError(/idempotency key/);
  });

  it("throws ElizaError with the reservation-invalid code and context", () => {
    try {
      createCalendarAvailabilityReservation({
        parent: baseParent,
        kind: "travel",
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T09:00:00.000Z",
        idempotencyKey: "k1",
      });
      expect.unreachable("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error & { code?: string }).code).toBe(
        "CALENDAR_AVAILABILITY_RESERVATION_INVALID",
      );
      expect((err as Error & { context?: unknown }).context).toEqual({
        startAt: "2026-01-01T10:00:00.000Z",
        endAt: "2026-01-01T09:00:00.000Z",
      });
    }
  });

  it("builds a travel reservation with structural metadata", () => {
    const event = createCalendarAvailabilityReservation({
      parent: baseParent,
      kind: "travel",
      startAt: "2026-01-01T10:00:00.000Z",
      endAt: "2026-01-01T11:00:00.000Z",
      idempotencyKey: "  trip-42  ",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(event.id).toBe("event-1:availability:travel:trip-42");
    expect(event.title).toBe("Travel buffer");
    expect(event.status).toBe("confirmed");
    expect(event.startAt).toBe("2026-01-01T10:00:00.000Z");
    expect(event.endAt).toBe("2026-01-01T11:00:00.000Z");
    expect(event.isAllDay).toBe(false);
    expect(event.metadata).toEqual({
      locallyManagedAvailability: true,
      availabilityKind: "travel",
      parentEventId: "event-1",
      idempotencyKey: "trip-42",
    });
    expect(event.syncedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("builds a hold reservation with the hold title", () => {
    const event = createCalendarAvailabilityReservation({
      parent: { ...baseParent, id: "event-2", externalId: "ext-2" },
      kind: "hold",
      startAt: "2026-02-01T10:00:00.000Z",
      endAt: "2026-02-01T12:00:00.000Z",
      idempotencyKey: "hold-1",
    });
    expect(event.title).toBe("Calendar hold");
    expect(event.id).toBe("event-2:availability:hold:hold-1");
    expect(event.externalId).toBe("eliza-availability:ext-2:hold:hold-1");
    expect(event.metadata.parentEventId).toBe("event-2");
  });
});
