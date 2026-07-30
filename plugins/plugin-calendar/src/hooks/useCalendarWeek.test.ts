// @vitest-environment jsdom

/**
 * Tests for the useCalendarWeek hook: date-window derivation and feed fetching
 * across day/week/month modes in jsdom against a stubbed calendar client.
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarFeedState,
  LifeOpsCalendarSourceHealth,
} from "@elizaos/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uiClient = vi.hoisted(() => ({
  getLifeOpsCalendarFeed: vi.fn(),
}));

const calendarWeekAppValue = vi.hoisted(() => ({
  t: (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("@elizaos/ui", () => ({
  client: uiClient,
  useApp: () => calendarWeekAppValue,
  useAppSelector: <T>(selector: (value: typeof calendarWeekAppValue) => T) =>
    selector(calendarWeekAppValue),
  useAppSelectorShallow: <T>(
    selector: (value: typeof calendarWeekAppValue) => T,
  ) => selector(calendarWeekAppValue),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: uiClient,
  ElizaClient: class {
    fetch = vi.fn(async () => ({}));
  },
}));

vi.mock("@elizaos/ui/state", () => ({
  useApp: () => calendarWeekAppValue,
  useAppSelector: <T>(selector: (value: typeof calendarWeekAppValue) => T) =>
    selector(calendarWeekAppValue),
  useAppSelectorShallow: <T>(
    selector: (value: typeof calendarWeekAppValue) => T,
  ) => selector(calendarWeekAppValue),
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

function source(
  over: Partial<LifeOpsCalendarSourceHealth> = {},
): LifeOpsCalendarSourceHealth {
  return {
    key: {
      provider: "google",
      side: "owner",
      grantId: "grant-work",
      connectorAccountId: "account-work",
      calendarId: "primary",
    },
    summary: "Work",
    accessRole: "owner",
    visibility: "details",
    status: "fresh",
    syncedAt: "2026-06-15T12:00:00.000Z",
    error: null,
    ...over,
  };
}

function feed(
  events: LifeOpsCalendarEvent[],
  state: LifeOpsCalendarFeedState = "complete",
  sources: LifeOpsCalendarSourceHealth[] = [source()],
): LifeOpsCalendarFeed {
  return {
    calendarId: "primary",
    events,
    source: "synced",
    state,
    sources,
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
    expect(result.current.feedState).toBe("complete");
    expect(result.current.status).toBe("ready");
    expect(result.current.sources.map((item) => item.summary)).toEqual([
      "Work",
    ]);

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
    expect(result.current.feedState).toBeNull();
    expect(result.current.sources).toEqual([]);
    expect(result.current.status).toBe("error");
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
    expect(result.current.status).toBe("loading");
    expect(result.current.refreshing).toBe(false);
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
    expect(result.current.status).toBe("ready");
  });

  it("distinguishes an authoritative empty feed from unavailable coverage", async () => {
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(feed([]));

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.feedState).toBe("complete");
    expect(result.current.sources[0]?.status).toBe("fresh");
  });

  it("preserves partial state and stale per-source truth", async () => {
    const staleSource = source({
      status: "stale",
      syncedAt: "2026-06-15T08:00:00.000Z",
      error: {
        code: "CALENDAR_SOURCE_REFRESH_FAILED",
        message: "Refresh failed.",
        retryable: true,
      },
    });
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(
      feed(
        [
          event(
            "cached",
            "2026-06-15T09:00:00.000Z",
            "2026-06-15T10:00:00.000Z",
          ),
        ],
        "partial",
        [staleSource],
      ),
    );

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.status).toBe("partial"));
    expect(result.current.feedState).toBe("partial");
    expect(result.current.sources).toEqual([staleSource]);
    expect(result.current.events.map((item) => item.id)).toEqual(["cached"]);
  });

  it("preserves revoked/disconnected source truth on an unavailable feed", async () => {
    const revokedSource = source({
      status: "disconnected",
      syncedAt: null,
      error: {
        code: "OAUTH_REVOKED",
        message: "Calendar authorization was revoked.",
        retryable: true,
      },
    });
    uiClient.getLifeOpsCalendarFeed.mockResolvedValue(
      feed([], "unavailable", [revokedSource]),
    );

    const { result } = renderHook(() => useCalendarWeek());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.feedState).toBe("unavailable");
    expect(result.current.events).toEqual([]);
    expect(result.current.sources[0]).toEqual(revokedSource);
  });

  it("keeps the prior feed visible while refresh is in flight and adopts its source state atomically", async () => {
    let resolveRefresh: ((value: LifeOpsCalendarFeed) => void) | undefined;
    uiClient.getLifeOpsCalendarFeed
      .mockResolvedValueOnce(
        feed([
          event(
            "initial",
            "2026-06-15T09:00:00.000Z",
            "2026-06-15T10:00:00.000Z",
          ),
        ]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<LifeOpsCalendarFeed>((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const { result } = renderHook(() => useCalendarWeek());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.events.map((item) => item.id)).toEqual(["initial"]);
    expect(result.current.feedState).toBe("complete");

    const stale = source({ status: "stale" });
    await act(async () => {
      resolveRefresh?.(
        feed(
          [
            event(
              "refreshed",
              "2026-06-16T09:00:00.000Z",
              "2026-06-16T10:00:00.000Z",
            ),
          ],
          "partial",
          [stale],
        ),
      );
      await refreshPromise;
    });

    expect(result.current.refreshing).toBe(false);
    expect(result.current.status).toBe("partial");
    expect(result.current.events.map((item) => item.id)).toEqual(["refreshed"]);
    expect(result.current.sources).toEqual([stale]);
  });

  it("keeps the prior feed and source truth visible when refresh fails", async () => {
    const originalSource = source({ summary: "Family" });
    uiClient.getLifeOpsCalendarFeed
      .mockResolvedValueOnce(
        feed(
          [
            event(
              "cached",
              "2026-06-15T09:00:00.000Z",
              "2026-06-15T10:00:00.000Z",
            ),
          ],
          "complete",
          [originalSource],
        ),
      )
      .mockRejectedValueOnce(new Error("refresh transport failed"));

    const { result } = renderHook(() => useCalendarWeek());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("refresh transport failed");
    expect(result.current.events.map((item) => item.id)).toEqual(["cached"]);
    expect(result.current.feedState).toBe("complete");
    expect(result.current.sources).toEqual([originalSource]);
    expect(result.current.refreshing).toBe(false);
  });

  it("ignores an older window response that resolves after the latest request", async () => {
    let resolveOld: ((value: LifeOpsCalendarFeed) => void) | undefined;
    let resolveLatest: ((value: LifeOpsCalendarFeed) => void) | undefined;
    uiClient.getLifeOpsCalendarFeed
      .mockImplementationOnce(
        () =>
          new Promise<LifeOpsCalendarFeed>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<LifeOpsCalendarFeed>((resolve) => {
            resolveLatest = resolve;
          }),
      );

    const { result } = renderHook(() => useCalendarWeek());
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalledTimes(1),
    );

    act(() => result.current.setViewMode("day"));
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendarFeed).toHaveBeenCalledTimes(2),
    );

    const latestSource = source({
      key: {
        provider: "microsoft",
        side: "owner",
        grantId: "grant-family",
        connectorAccountId: "account-family",
        calendarId: "family",
      },
      summary: "Family",
    });
    await act(async () => {
      resolveLatest?.(
        feed(
          [
            event(
              "latest",
              "2026-06-16T12:00:00.000Z",
              "2026-06-16T13:00:00.000Z",
            ),
          ],
          "complete",
          [latestSource],
        ),
      );
    });
    await waitFor(() =>
      expect(result.current.events.map((item) => item.id)).toEqual(["latest"]),
    );

    await act(async () => {
      resolveOld?.(
        feed(
          [
            event(
              "old",
              "2026-06-15T09:00:00.000Z",
              "2026-06-15T10:00:00.000Z",
            ),
          ],
          "partial",
          [source({ status: "error" })],
        ),
      );
    });

    expect(result.current.events.map((item) => item.id)).toEqual(["latest"]);
    expect(result.current.status).toBe("ready");
    expect(result.current.sources).toEqual([latestSource]);
  });
});
