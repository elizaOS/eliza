// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));

// Mock the client so getBaseUrl resolves without booting the real ElizaClient.
vi.mock("../../../api", () => ({
  client: { getBaseUrl: () => "http://localhost" },
}));

// Spy on the self-signal hook to assert the urgent weight is published.
vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: publishMock,
}));

import { CalendarUpcomingWidget } from "./calendar-upcoming";

// Minimal wire event matching LifeOpsCalendarEvent (@elizaos/shared
// contracts/calendar.ts) — only the fields the widget reads.
function event(
  overrides: Partial<{
    id: string;
    title: string;
    startAt: string;
    endAt: string;
    isAllDay: boolean;
    location: string;
  }> = {},
) {
  return {
    id: "evt-1",
    title: "Standup",
    startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    isAllDay: false,
    location: "",
    ...overrides,
  };
}

function mockFeed(events: ReturnType<typeof event>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ events }),
    })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishMock.mockReset();
});

describe("CalendarUpcomingWidget (#9143)", () => {
  it("renders upcoming event rows from the feed", async () => {
    mockFeed([
      event({ id: "a", title: "Standup" }),
      event({
        id: "b",
        title: "Lunch",
        startAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget events={[]} clearEvents={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("Standup")).toBeTruthy();
    });
    expect(screen.getByText("Lunch")).toBeTruthy();
  });

  it("renders nothing when there are no upcoming events", async () => {
    mockFeed([
      // A past event — filtered out (startAt < now).
      event({
        id: "past",
        startAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(
      <CalendarUpcomingWidget events={[]} clearEvents={() => {}} />,
    );
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("publishes the reminder weight when an event starts within 2 hours (home slot)", async () => {
    mockFeed([
      event({
        id: "imminent",
        title: "Call",
        startAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    ]);
    render(
      <CalendarUpcomingWidget events={[]} clearEvents={() => {}} slot="home" />,
    );
    await waitFor(() => {
      expect(screen.getByText("Call")).toBeTruthy();
    });
    expect(publishMock).toHaveBeenCalledWith(
      "calendar/calendar.upcoming",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });
});
