// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// useWidgetNavigation → reportUserViewSwitch (from the slash-command controller);
// stub it so the click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

import type { WidgetProps } from "../../../widgets/types";
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

const fetchProps: Partial<WidgetProps> = { slot: "home" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  publishMock.mockReset();
});

describe("CalendarUpcomingWidget (#9143)", () => {
  it("shows ONE high-priority datum — the next upcoming event — minimal, icon-first", async () => {
    mockFeed([
      event({
        id: "a",
        title: "Standup",
        startAt: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      }),
      event({
        id: "b",
        title: "Lunch",
        startAt: new Date(Date.now() + 7 * 60 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-calendar-upcoming")).toBeTruthy();
    });

    const widget = screen.getByTestId("chat-widget-calendar-upcoming");
    // The card is a button (whole-card clickable) and minimal: only the soonest
    // event is shown; later events are NOT (just a count badge).
    expect(widget.tagName).toBe("BUTTON");
    expect(widget.textContent).toContain("Standup");
    expect(widget.textContent).not.toContain("Lunch");
    // The further-upcoming count rides as a badge.
    expect(widget.textContent).toContain("+1");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(widget.getAttribute("aria-label")).toMatch(/Standup/);
    expect(widget.getAttribute("aria-label")).toMatch(/Open Calendar/);
  });

  it("publishes the reminder weight when the next event starts within 2 hours (home slot)", async () => {
    mockFeed([
      event({
        id: "imminent",
        title: "Call",
        startAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    ]);
    render(<CalendarUpcomingWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-calendar-upcoming")).toBeTruthy();
    });
    expect(publishMock).toHaveBeenLastCalledWith(
      "calendar/calendar.upcoming",
      HOME_SIGNAL_WEIGHTS.reminder,
    );
  });

  it("navigates to the Calendar view when the card is clicked", async () => {
    mockFeed([event({ id: "a", title: "Standup" })]);
    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<CalendarUpcomingWidget {...fetchProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("chat-widget-calendar-upcoming")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("chat-widget-calendar-upcoming"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/calendar");
  });

  it("renders null when there are no upcoming events", async () => {
    mockFeed([
      // A past event — filtered out (startAt < now).
      event({
        id: "past",
        startAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    const { container } = render(<CalendarUpcomingWidget {...fetchProps} />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });
    await Promise.resolve();

    expect(screen.queryByTestId("chat-widget-calendar-upcoming")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
