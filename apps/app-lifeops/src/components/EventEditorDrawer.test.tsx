// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";

const { clientMock, selectState } = vi.hoisted(() => ({
  clientMock: {
    createLifeOpsCalendarEvent: vi.fn(),
    deleteLifeOpsCalendarEvent: vi.fn(),
    getLifeOpsCalendars: vi.fn(),
    updateLifeOpsCalendarEvent: vi.fn(),
  },
  selectState: {
    onValueChange: null as ((value: string) => void) | null,
    value: "",
  },
}));

vi.mock("@elizaos/app-core", () => {
  return {
    Button: ({
      children,
      onClick,
      ...rest
    }: {
      children: React.ReactNode;
      onClick?: () => void;
    } & Record<string, unknown>) => (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    ),
    ConfirmDialog: () => null,
    client: clientMock,
    Dialog: ({
      children,
      open,
    }: {
      children: React.ReactNode;
      open: boolean;
    }) => (open ? <>{children}</> : null),
    DialogContent: ({ children, ...rest }: Record<string, unknown>) => (
      <div {...rest}>{children as React.ReactNode}</div>
    ),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    Select: ({
      children,
      onValueChange,
      value,
    }: {
      children: React.ReactNode;
      onValueChange: (value: string) => void;
      value: string;
    }) => {
      selectState.onValueChange = onValueChange;
      selectState.value = value;
      return <div data-select-value={value}>{children}</div>;
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      return (
        <button
          type="button"
          aria-pressed={selectState.value === value}
          onClick={() => selectState.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    SelectTrigger: ({
      children,
      ...rest
    }: {
      children: React.ReactNode;
    } & Record<string, unknown>) => <div {...rest}>{children}</div>,
    SelectValue: () => null,
    TagInput: ({
      addLabel,
      items,
      onChange,
      placeholder,
      removeLabel,
    }: {
      addLabel: string;
      items: string[];
      onChange: (items: string[]) => void;
      placeholder: string;
      removeLabel: string;
    }) => (
      <div>
        <input
          aria-label={placeholder}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const input = event.currentTarget;
            if (!input.value.trim()) return;
            onChange([...items, input.value.trim()]);
            input.value = "";
          }}
        />
        <span>{addLabel}</span>
        {items.map((item) => (
          <button
            key={item}
            type="button"
            aria-label={`${removeLabel} ${item}`}
            onClick={() => onChange(items.filter((value) => value !== item))}
          >
            {item}
          </button>
        ))}
      </div>
    ),
    Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea {...props} />
    ),
    useApp: () => ({
      setActionNotice: vi.fn(),
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? "",
    }),
  };
});

import { EventEditorDrawer } from "./EventEditorDrawer";

const calendars: LifeOpsCalendarSummary[] = [
  {
    provider: "google",
    side: "owner",
    grantId: "grant-personal",
    accountEmail: "personal@example.test",
    calendarId: "primary",
    summary: "Personal",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
  },
  {
    provider: "google",
    side: "owner",
    grantId: "grant-work",
    accountEmail: "work@example.test",
    calendarId: "primary",
    summary: "Work",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
  },
];

function event(overrides: Partial<LifeOpsCalendarEvent> = {}): LifeOpsCalendarEvent {
  return {
    id: "event-1",
    externalId: "google-event-1",
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    grantId: "grant-personal",
    accountEmail: "personal@example.test",
    calendarId: "primary",
    title: "Planning",
    description: "Bring notes",
    location: "Office",
    status: "confirmed",
    startAt: "2026-04-23T15:00:00.000Z",
    endAt: "2026-04-23T16:00:00.000Z",
    isAllDay: false,
    timezone: "America/Los_Angeles",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [
      {
        email: "alice@example.test",
        displayName: "Alice",
        responseStatus: "accepted",
        self: false,
        organizer: false,
        optional: false,
      },
    ],
    metadata: {},
    syncedAt: "2026-04-23T14:00:00.000Z",
    updatedAt: "2026-04-23T14:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EventEditorDrawer", () => {
  it("persists visible edit fields and explicit attendee/location clears", async () => {
    const updated = event({ attendees: [], location: "" });
    clientMock.getLifeOpsCalendars.mockResolvedValue({ calendars });
    clientMock.updateLifeOpsCalendarEvent.mockResolvedValue({ event: updated });

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={event()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("Repeat")).toBeNull();
    expect(screen.queryByText("Reminders")).toBeNull();

    fireEvent.change(screen.getByLabelText("Event location"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove alice@example.test" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(clientMock.updateLifeOpsCalendarEvent).toHaveBeenCalled();
    });
    expect(clientMock.updateLifeOpsCalendarEvent).toHaveBeenCalledWith(
      "google-event-1",
      expect.objectContaining({
        calendarId: "primary",
        grantId: "grant-personal",
        location: "",
        attendees: [],
      }),
    );
    expect(clientMock.updateLifeOpsCalendarEvent.mock.calls[0]?.[1]).not.toHaveProperty(
      "recurrence",
    );
    expect(clientMock.updateLifeOpsCalendarEvent.mock.calls[0]?.[1]).not.toHaveProperty(
      "reminders",
    );
  });

  it("uses grantId plus calendarId when selecting among duplicate primary calendars", async () => {
    const created = event({
      id: "event-created",
      externalId: "google-event-created",
      grantId: "grant-work",
      accountEmail: "work@example.test",
      attendees: [],
      location: "",
      title: "Work review",
    });
    clientMock.getLifeOpsCalendars.mockResolvedValue({ calendars });
    clientMock.createLifeOpsCalendarEvent.mockResolvedValue({ event: created });

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{
          date: new Date("2026-04-23T15:00:00.000Z"),
          side: "owner",
        }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Work/ })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Work/ }));
    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Work review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(clientMock.createLifeOpsCalendarEvent).toHaveBeenCalled();
    });
    expect(clientMock.createLifeOpsCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        side: "owner",
        grantId: "grant-work",
        calendarId: "primary",
        title: "Work review",
      }),
    );
  });
});
