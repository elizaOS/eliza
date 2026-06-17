// @vitest-environment jsdom

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uiClient = vi.hoisted(() => ({
  getLifeOpsCalendarFeed: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  client: uiClient,
  useApp: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
  }),
}));

import { useCalendarWeek } from "./useCalendarWeek.js";

function event(
  id: string,
  startAt: string,
  endAt: string,
): LifeOpsCalendarEvent {
  return {
    id,
    externalId: id,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: `Event ${id}`,
    description: "",
    location: "",
    status: "confirmed",
    startAt,
    endAt,
    isAllDay: false,
    timezone: null,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: startAt,
    updatedAt: startAt,
  };
}

function feed(events: LifeOpsCalendarEvent[]): LifeOpsCalendarFeed {
  return {
    calendarId: "primary",
    events,
    source: "synced",
    timeMin: "",
    timeMax: "",
    syncedAt: null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function lastFeedArgs(): {
  side: string;
  timeMin: string;
  timeMax: string;
  timeZone: string;
} {
  const calls = uiClient.getLifeOpsCalendarFeed.mock.calls;
  return calls[calls.length - 1][0] as {
    side: string;
    timeMin: string;
    timeMax: string;
    timeZone: string;
  };
}

function windowSpanDays(): number {
  const args = lastFeedArgs();
  return Math.round(
    (Date.parse(args.timeMax) - Date.parse(args.timeMin)) / DAY_MS,
  );
}

describe("useCalendarWeek", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(feed([]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the owner feed and returns events sorted by startAt", async () => {
    // Deliberately out of chronological order.
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(
      feed([
        event("c", "2026-06-17T18:00:00.000Z", "2026-06-17T19:00:00.000Z"),
        event("a", "2026-06-15T09:00:00.000Z", "2026-06-15T10:00:00.000Z"),
        event("b", "2026-06-16T12:00:00.000Z", "2026-06-16T13:00:00.000Z"),
      ]),
    );

    const baseDate = new Date("2026-06-15T12:00:00.000Z");
    const { result } = renderHook(() => useCalendarWeek({ baseDate }));

    await waitFor(() => expect(result.current.events).toHaveLength(3));

    expect(result.current.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    const args = lastFeedArgs();
    expect(args.side).toBe("owner");
    // week mode -> 7-day window starting at local midnight of baseDate.
    expect(windowSpanDays()).toBe(7);
    expect(typeof args.timeZone).toBe("string");
  });

  it("recomputes a 1-day window for day mode and a 42-day grid for month mode", async () => {
    const baseDate = new Date("2026-06-15T12:00:00.000Z");
    const { result } = renderHook(() => useCalendarWeek({ baseDate }));

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalled(),
    );
    expect(windowSpanDays()).toBe(7); // week default

    act(() => result.current.setViewMode("day"));
    await waitFor(() => expect(windowSpanDays()).toBe(1));

    act(() => result.current.setViewMode("month"));
    await waitFor(() => expect(windowSpanDays()).toBe(42));

    // month window starts on the Sunday on/before the 1st of the month.
    // Assert against the hook's own windowStart Date (the ISO round-trip is
    // local-tz lossy across midnight, so we use the Date the hook exposes).
    expect(result.current.windowStart.getDay()).toBe(0);
  });

  it("shifts the window by the mode span on goNext/goPrevious", async () => {
    const baseDate = new Date("2026-06-15T12:00:00.000Z");
    const { result } = renderHook(() =>
      useCalendarWeek({ baseDate, viewMode: "week" }),
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalled(),
    );
    // Compare against the hook's own windowStart Date to avoid ISO/DST drift.
    const baseStart = result.current.windowStart.getTime();

    act(() => result.current.goNext());
    await waitFor(() => {
      expect(result.current.windowStart.getTime()).toBe(baseStart + 7 * DAY_MS);
    });

    act(() => result.current.goPrevious());
    act(() => result.current.goPrevious());
    await waitFor(() => {
      expect(result.current.windowStart.getTime()).toBe(baseStart - 7 * DAY_MS);
    });
  });

  it("steps a whole month on goNext in month mode", async () => {
    const baseDate = new Date("2026-06-15T12:00:00.000Z");
    const { result } = renderHook(() =>
      useCalendarWeek({ baseDate, viewMode: "month" }),
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalled(),
    );
    const juneBase = result.current.baseDate.getMonth();

    act(() => result.current.goNext());
    await waitFor(() => {
      // baseDate advanced exactly one calendar month.
      expect(result.current.baseDate.getMonth()).toBe((juneBase + 1) % 12);
    });
  });

  it("resets the base date to today on goToToday", async () => {
    // Start far in the past so "today" is unambiguously different.
    const baseDate = new Date("2020-01-01T12:00:00.000Z");
    const { result } = renderHook(() => useCalendarWeek({ baseDate }));

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalled(),
    );
    expect(result.current.baseDate.getFullYear()).toBe(2020);

    const today = new Date();
    act(() => result.current.goToToday());
    await waitFor(() => {
      expect(result.current.baseDate.getFullYear()).toBe(today.getFullYear());
      expect(result.current.baseDate.getMonth()).toBe(today.getMonth());
      expect(result.current.baseDate.getDate()).toBe(today.getDate());
    });
  });

  it("surfaces an error message when the feed fetch rejects", async () => {
    uiClient.getLifeOpsCalendarFeed.mockRejectedValue(
      new Error("network down"),
    );

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.error).toBe("network down"));
    expect(result.current.loading).toBe(false);
    expect(result.current.events).toEqual([]);
  });

  it("holds loading true while the fetch is in flight", async () => {
    // A never-resolving fetch leaves the hook in its in-flight state.
    uiClient.getLifeOpsCalendarFeed.mockImplementation(
      () => new Promise<LifeOpsCalendarFeed>(() => {}),
    );

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("settles loading false with events after the feed resolves", async () => {
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(
      feed([
        event("x", "2026-06-15T09:00:00.000Z", "2026-06-15T10:00:00.000Z"),
      ]),
    );

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.events.map((e) => e.id)).toEqual(["x"]);
    expect(typeof result.current.refresh).toBe("function");
  });
});
