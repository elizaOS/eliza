// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useCalendarWeekMock, useLifeOpsSelectionMock } = vi.hoisted(() => ({
  useCalendarWeekMock: vi.fn(),
  useLifeOpsSelectionMock: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  SegmentedControl: ({
    items,
    onValueChange,
    value,
  }: {
    items: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <div>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
  Spinner: () => null,
  useApp: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
  }),
  useMediaQuery: () => true,
}));

vi.mock("../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: () => useCalendarWeekMock(),
}));

vi.mock("../lifeops-route.js", () => ({
  getPrimedLifeOpsEvent: () => null,
}));

vi.mock("./EventEditorDrawer.js", () => ({
  EventEditorDrawer: ({
    event,
    onClose,
    open,
  }: {
    event: { title: string } | null;
    onClose: () => void;
    open: boolean;
  }) =>
    open && event ? (
      <div data-testid="mock-event-editor">
        <span>{event.title}</span>
        <button type="button" onClick={onClose}>
          Close editor
        </button>
      </div>
    ) : null,
}));

vi.mock("./LifeOpsChatAdapter.js", () => ({
  useLifeOpsChatLauncher: () => ({
    chatAboutEvent: vi.fn(),
  }),
}));

vi.mock("./LifeOpsSelectionContext.js", () => ({
  useLifeOpsSelection: () => useLifeOpsSelectionMock(),
}));

import { LifeOpsCalendarSection } from "./LifeOpsCalendarSection";

afterEach(() => {
  cleanup();
  useCalendarWeekMock.mockReset();
  useLifeOpsSelectionMock.mockReset();
});

describe("LifeOpsCalendarSection", () => {
  it("clears the selected event when the event editor closes", async () => {
    const event = {
      id: "event-1",
      externalId: "external-1",
      agentId: "agent-1",
      provider: "google",
      side: "owner",
      calendarId: "primary",
      title: "Dentist Appointment",
      description: "",
      location: "",
      status: "confirmed",
      startAt: "2026-04-23T15:00:00.000Z",
      endAt: "2026-04-23T16:00:00.000Z",
      isAllDay: false,
      timezone: "America/Los_Angeles",
      htmlLink: null,
      conferenceLink: null,
      organizer: null,
      attendees: [],
      metadata: {},
      syncedAt: "2026-04-23T14:00:00.000Z",
      updatedAt: "2026-04-23T14:00:00.000Z",
    } as const;
    const onSelect = vi.fn();

    useCalendarWeekMock.mockReturnValue({
      error: null,
      events: [event],
      goNext: vi.fn(),
      goPrevious: vi.fn(),
      goToToday: vi.fn(),
      loading: false,
      refresh: vi.fn(),
      setViewMode: vi.fn(),
      viewMode: "week",
      windowEnd: new Date("2026-04-30T00:00:00.000Z"),
      windowStart: new Date("2026-04-23T00:00:00.000Z"),
    });
    useLifeOpsSelectionMock.mockReturnValue({
      selection: { eventId: null, messageId: null, reminderId: null },
      select: vi.fn(),
    });

    render(
      <LifeOpsCalendarSection
        selection={{ eventId: "event-1", messageId: null, reminderId: null }}
        onSelect={onSelect}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("mock-event-editor")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));

    expect(onSelect).toHaveBeenCalledWith({ eventId: null });
  });
});
