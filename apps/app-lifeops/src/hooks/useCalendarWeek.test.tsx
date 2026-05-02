// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getLifeOpsCalendarFeedMock } = vi.hoisted(() => ({
  getLifeOpsCalendarFeedMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  client: {
    getLifeOpsCalendarFeed: getLifeOpsCalendarFeedMock,
  },
  useApp: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
  }),
}));

import { useCalendarWeek } from "./useCalendarWeek";

function expectedMonthGridStart(baseDate: Date): Date {
  const first = new Date(baseDate);
  first.setHours(0, 0, 0, 0);
  first.setDate(1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return start;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useCalendarWeek", () => {
  it("fetches the same 42-day window that month view renders", async () => {
    const expectedEvent: LifeOpsCalendarEvent = {
      id: "event-1",
      externalId: "external-1",
      agentId: "agent-1",
      provider: "google",
      side: "owner",
      calendarId: "primary",
      title: "Planning",
      description: "",
      location: "",
      status: "confirmed",
      startAt: "2026-04-15T16:00:00.000Z",
      endAt: "2026-04-15T17:00:00.000Z",
      isAllDay: false,
      timezone: "UTC",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: "2026-04-23T12:00:00.000Z",
      updatedAt: "2026-04-23T12:00:00.000Z",
    };

    getLifeOpsCalendarFeedMock.mockResolvedValue({
      calendarId: "all",
      events: [expectedEvent],
      source: "synced",
      timeMin: "",
      timeMax: "",
      syncedAt: "2026-04-23T12:00:00.000Z",
    });

    const baseDate = new Date("2026-04-15T12:00:00.000Z");
    const { result } = renderHook(() =>
      useCalendarWeek({ viewMode: "month", baseDate }),
    );

    await waitFor(() => {
      expect(getLifeOpsCalendarFeedMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current.events).toEqual([expectedEvent]);
    });

    const expectedStart = expectedMonthGridStart(baseDate);
    const expectedEnd = new Date(expectedStart);
    expectedEnd.setDate(expectedStart.getDate() + 42);

    expect(result.current.baseDate).toEqual(baseDate);
    expect(result.current.windowStart).toEqual(expectedStart);
    expect(result.current.windowEnd).toEqual(expectedEnd);
    expect(getLifeOpsCalendarFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeMin: expectedStart.toISOString(),
        timeMax: expectedEnd.toISOString(),
      }),
    );
  });
});
