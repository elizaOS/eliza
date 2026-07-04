// @vitest-environment jsdom

/**
 * Tests for the EventEditorDrawer create/edit form: field population, attendee
 * editing, and submit-payload shape in jsdom against fixture calendars (no live
 * service).
 */

import type {
  LifeOpsCalendarEvent,
  ListLifeOpsCalendarsResponse,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { forwardRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @elizaos/ui: spied calendar client + lightweight form-control stubs.
// ---------------------------------------------------------------------------

const uiClient = vi.hoisted(() => ({
  getLifeOpsCalendars: vi.fn(),
  createLifeOpsCalendarEvent: vi.fn(),
  updateLifeOpsCalendarEvent: vi.fn(),
  deleteLifeOpsCalendarEvent: vi.fn(),
}));

vi.mock("@elizaos/ui", () => {
  const Input = forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement>
  >((props, ref) => <input ref={ref} {...props} />);
  Input.displayName = "Input";

  const Textarea = forwardRef<
    HTMLTextAreaElement,
    React.TextareaHTMLAttributes<HTMLTextAreaElement>
  >((props, ref) => <textarea ref={ref} {...props} />);
  Textarea.displayName = "Textarea";

  // The drawer imports `../api/client-calendar.js` for its side effect, which
  // augments `ElizaClient.prototype`. Provide a throwaway class so that import
  // resolves; we exercise the spied `client` object, not the prototype.
  class ElizaClient {
    fetch = vi.fn(async () => ({}) as never);
  }

  const appValue = {
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setActionNotice: vi.fn(),
  };

  return {
    ElizaClient,
    client: uiClient,
    Button: forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement>
    >(({ children, ...props }, ref) => (
      <button type="button" ref={ref} {...props}>
        {children}
      </button>
    )),
    Input,
    Textarea,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({
      children,
      ...props
    }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    // Native-select stub: walks SelectItem descendants to build selectable
    // <option>s (value/onValueChange) AND renders the raw children so the
    // SelectItem summary/account text is queryable in the DOM.
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => {
      const options: string[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
          return;
        }
        if (node && typeof node === "object" && "props" in node) {
          // biome-ignore lint/suspicious/noExplicitAny: test stub introspection
          const anyNode = node as any;
          if (anyNode.props?.["data-select-item-value"]) {
            options.push(anyNode.props["data-select-item-value"]);
          }
          walk(anyNode.props?.children);
        }
      };
      walk(children);
      return (
        <div data-testid="calendar-select-wrap">
          <select
            data-testid="calendar-select"
            value={options.includes(value) ? value : ""}
            onChange={(e) => onValueChange(e.target.value)}
          >
            {!options.includes(value) ? <option value="">--</option> : null}
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          {/* render raw items so their text/labels appear in the DOM */}
          <div data-testid="calendar-select-items">{children}</div>
        </div>
      );
    },
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => (
      <div data-select-item data-select-item-value={value}>
        {children}
      </div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => (
      <span>{placeholder}</span>
    ),
    TagEditor: ({
      items,
      onChange,
      placeholder,
    }: {
      items: string[];
      onChange: (items: string[]) => void;
      placeholder?: string;
    }) => (
      <div data-testid="tag-editor">
        {items.map((item) => (
          <span key={item} data-testid="attendee-chip">
            {item}
          </span>
        ))}
        <input
          data-testid="attendee-input"
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const value = (e.target as HTMLInputElement).value;
              onChange([...items, value]);
            }
          }}
        />
      </div>
    ),
    ConfirmDialog: ({
      open,
      message,
      confirmLabel = "Confirm",
      onConfirm,
      onCancel,
    }: {
      open: boolean;
      message: string;
      confirmLabel?: string;
      onConfirm: () => void;
      onCancel: () => void;
    }) =>
      open ? (
        <div data-testid="confirm-dialog">
          <span>{message}</span>
          <button
            type="button"
            data-testid="confirm-delete"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button type="button" onClick={onCancel}>
            cancel
          </button>
        </div>
      ) : null,
    useApp: () => appValue,
    useAppSelector: <T,>(selector: (value: typeof appValue) => T) =>
      selector(appValue),
    useAppSelectorShallow: <T,>(selector: (value: typeof appValue) => T) =>
      selector(appValue),
  };
});

vi.mock("@elizaos/ui/api", () => ({
  client: uiClient,
  ElizaClient: class {
    fetch = vi.fn(async () => ({}));
  },
}));

vi.mock("@elizaos/ui/components", async () => {
  return await vi.importMock<Record<string, unknown>>("@elizaos/ui");
});

vi.mock("@elizaos/ui/state", async () => {
  const ui = await vi.importMock<{
    useApp: () => unknown;
    useAppSelector: <T>(selector: (value: unknown) => T) => T;
    useAppSelectorShallow: <T>(selector: (value: unknown) => T) => T;
  }>("@elizaos/ui");
  return {
    useApp: ui.useApp,
    useAppSelector: ui.useAppSelector,
    useAppSelectorShallow: ui.useAppSelectorShallow,
  };
});

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

import { EventEditorDrawer } from "./EventEditorDrawer.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const calendarsResponse: ListLifeOpsCalendarsResponse = {
  calendars: [
    {
      provider: "google",
      side: "owner",
      grantId: "connector-account:acct-1",
      accountEmail: "owner@example.com",
      calendarId: "owner@example.com",
      summary: "Owner Calendar",
      description: null,
      primary: true,
      accessRole: "owner",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/New_York",
      selected: true,
      includeInFeed: true,
    },
    {
      provider: "google",
      side: "owner",
      grantId: "connector-account:acct-1",
      accountEmail: "owner@example.com",
      calendarId: "team@example.com",
      summary: "Team Calendar",
      description: null,
      primary: false,
      accessRole: "writer",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/New_York",
      selected: true,
      includeInFeed: true,
    },
  ],
};

const editEvent: LifeOpsCalendarEvent = {
  id: "agent-1:google:owner:calendar:owner@example.com:evt_1",
  externalId: "evt_1",
  agentId: "agent-1",
  provider: "google",
  side: "owner",
  calendarId: "owner@example.com",
  title: "Quarterly review",
  description: "Numbers walkthrough",
  location: "HQ Boardroom",
  status: "confirmed",
  startAt: new Date(2026, 5, 17, 14, 0, 0).toISOString(),
  endAt: new Date(2026, 5, 17, 15, 0, 0).toISOString(),
  isAllDay: false,
  timezone: "America/New_York",
  htmlLink: null,
  conferenceLink: null,
  organizer: null,
  attendees: [
    {
      email: "cfo@example.com",
      displayName: "CFO",
      responseStatus: null,
      self: false,
      organizer: false,
      optional: false,
    },
  ],
  metadata: {},
  syncedAt: new Date(2026, 5, 16).toISOString(),
  updatedAt: new Date(2026, 5, 16).toISOString(),
  grantId: "connector-account:acct-1",
};

function saveButton(): HTMLButtonElement {
  // The primary action button's accessible name comes from its sr-only span
  // ("Create" in create mode, "Save" in edit mode).
  return screen
    .getByText("Create", { selector: "span.sr-only" })
    .closest("button") as HTMLButtonElement;
}

function editSaveButton(): HTMLButtonElement {
  return screen
    .getByText("Save", { selector: "span.sr-only" })
    .closest("button") as HTMLButtonElement;
}

describe("EventEditorDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiClient.getLifeOpsCalendars.mockResolvedValue(calendarsResponse);
  });

  afterEach(() => {
    cleanup();
  });

  // ----- create mode --------------------------------------------------------

  it("seeds a blank create form with a next-half-hour start window", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{
          date: new Date(2026, 5, 15, 9, 12, 0),
          side: "owner",
        }}
        onClose={vi.fn()}
      />,
    );

    const title = screen.getByLabelText("Event title") as HTMLInputElement;
    expect(title.value).toBe("");

    const start = document.getElementById(
      "event-editor-start-at",
    ) as HTMLInputElement;
    const end = document.getElementById(
      "event-editor-end-at",
    ) as HTMLInputElement;
    // 09:12 rounds up to the next half hour -> 09:30, end +30min -> 10:00.
    expect(start.value).toBe("2026-06-15T09:30");
    expect(end.value).toBe("2026-06-15T10:00");

    // Create button is disabled while the title is empty.
    expect(saveButton().disabled).toBe(true);
  });

  it("populates the calendar select from getLifeOpsCalendars", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ side: "owner" }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalledWith({
        side: "owner",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Owner Calendar")).toBeTruthy(),
    );
    expect(screen.getByText("Team Calendar")).toBeTruthy();
  });

  it("falls back to a 'Primary' calendar row when the calendars fetch fails", async () => {
    uiClient.getLifeOpsCalendars.mockRejectedValue(new Error("boom"));

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ side: "owner" }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("creates an event with the trimmed title/start/end and fires onCreated", async () => {
    uiClient.createLifeOpsCalendarEvent.mockResolvedValue({
      event: { ...editEvent, id: "new-id", title: "Coffee" },
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ date: new Date(2026, 5, 15, 9, 0, 0), side: "owner" }}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "  Coffee  " },
    });
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(uiClient.createLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    const request = uiClient.createLifeOpsCalendarEvent.mock.calls[0][0];
    expect(request.title).toBe("Coffee"); // trimmed
    expect(request.side).toBe("owner");
    expect(request.startAt).toContain("2026-06-15T");
    expect(request.endAt).toContain("2026-06-15T");
    expect(typeof request.timeZone).toBe("string");

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces an invalid-times error when start/end are cleared", async () => {
    render(
      <EventEditorDrawer
        open
        mode="create"
        event={null}
        createDefaults={{ date: new Date(2026, 5, 15, 9, 0, 0), side: "owner" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Coffee" },
    });
    fireEvent.change(
      document.getElementById("event-editor-start-at") as HTMLInputElement,
      { target: { value: "" } },
    );
    fireEvent.change(
      document.getElementById("event-editor-end-at") as HTMLInputElement,
      { target: { value: "" } },
    );

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Pick valid start and end times.")).toBeTruthy(),
    );
    expect(uiClient.createLifeOpsCalendarEvent).not.toHaveBeenCalled();
  });

  // ----- edit mode ----------------------------------------------------------

  it("seeds the edit form from the event (title/location/attendees/notes)", async () => {
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText("Event title") as HTMLInputElement).value,
    ).toBe("Quarterly review");
    expect(
      (screen.getByLabelText("Event location") as HTMLInputElement).value,
    ).toBe("HQ Boardroom");
    expect(
      (document.getElementById("event-editor-notes") as HTMLTextAreaElement)
        .value,
    ).toBe("Numbers walkthrough");
    expect(screen.getByTestId("attendee-chip").textContent).toBe(
      "cfo@example.com",
    );
  });

  it("PATCHes only the changed title via updateLifeOpsCalendarEvent and fires onSaved", async () => {
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({
      event: { ...editEvent, title: "Quarterly review (final)" },
    });
    const onSaved = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Quarterly review (final)" },
    });
    fireEvent.click(editSaveButton());

    await waitFor(() =>
      expect(uiClient.updateLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    const [externalId, patch] =
      uiClient.updateLifeOpsCalendarEvent.mock.calls[0];
    expect(externalId).toBe("evt_1");
    // Patch only carries the changed title (plus routing fields), not start/end.
    expect(patch.title).toBe("Quarterly review (final)");
    expect(patch.startAt).toBeUndefined();
    expect(patch.endAt).toBeUndefined();
    expect(patch.location).toBeUndefined();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("deletes via the confirm dialog and fires onDeleted", async () => {
    uiClient.deleteLifeOpsCalendarEvent.mockResolvedValue(undefined);
    const onDeleted = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );

    // Open the confirm dialog via the Delete action.
    fireEvent.click(
      screen
        .getByText("Delete", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );
    const confirm = await screen.findByTestId("confirm-dialog");
    expect(confirm).toBeTruthy();

    fireEvent.click(screen.getByTestId("confirm-delete"));

    await waitFor(() =>
      expect(uiClient.deleteLifeOpsCalendarEvent).toHaveBeenCalledWith(
        "evt_1",
        {
          side: "owner",
          grantId: "connector-account:acct-1",
          calendarId: "owner@example.com",
        },
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(editEvent.id));
  });

  it("invokes onChat with the event from the Chat action (edit mode only)", async () => {
    const onChat = vi.fn();
    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={vi.fn()}
        onChat={onChat}
      />,
    );

    fireEvent.click(
      screen
        .getByText("Chat", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );
    expect(onChat).toHaveBeenCalledWith(editEvent);
  });

  it("keeps the drawer open on save-and-continue", async () => {
    uiClient.updateLifeOpsCalendarEvent.mockResolvedValue({
      event: { ...editEvent, title: "Renamed" },
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();

    render(
      <EventEditorDrawer
        open
        mode="edit"
        event={editEvent}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await waitFor(() =>
      expect(uiClient.getLifeOpsCalendars).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Event title"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(
      screen
        .getByText("Save and continue", { selector: "span.sr-only" })
        .closest("button") as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(uiClient.updateLifeOpsCalendarEvent).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Save-and-continue does NOT close the drawer.
    expect(onClose).not.toHaveBeenCalled();
  });
});
