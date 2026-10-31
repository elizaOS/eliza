// @vitest-environment jsdom

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
} from "@elizaos/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEditorDrawer } from "./EventEditorDrawer";

// The drawer's completion-callback logic is the unit under test. The
// @elizaos/ui leaf primitives and store are stubbed at the module boundary
// (the checkout has no built @elizaos/host dist, so the real UI index cannot
// resolve here); the shared `client` object is stubbed per-test below.
vi.mock("@elizaos/ui", async () => {
  const React = await import("react");
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return {
    client: {},
    ElizaClient: class ElizaClient {},
    seedAppValue: () => {},
    useAppSelector: (selector: (state: unknown) => unknown) =>
      selector({ t, setActionNotice: () => {} }),
    useActiveAgentAuthority: () => "test-authority",
    getActiveAgentAuthority: () => "test-authority",
    useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
    dispatchNavigateViewEvent: () => {},
    Button: ({
      children,
      variant: _variant,
      size: _size,
      ...props
    }: React.ComponentProps<"button"> & {
      variant?: string;
      size?: string;
    }) => <button {...props}>{children}</button>,
    Input: React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
      (props, ref) => <input ref={ref} {...props} />,
    ),
    Textarea: React.forwardRef<
      HTMLTextAreaElement,
      React.ComponentProps<"textarea">
    >((props, ref) => <textarea ref={ref} {...props} />),
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div>{children}</div> : null),
    DialogContent: ({
      children,
      showCloseButton: _showCloseButton,
      ...props
    }: React.ComponentProps<"div"> & { showCloseButton?: boolean }) => (
      <div {...props}>{children}</div>
    ),
    Select: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value: _value,
      ...props
    }: React.ComponentProps<"div"> & { value: string }) => (
      <div {...props}>{children}</div>
    ),
    TagEditor: () => <div data-testid="tag-editor" />,
    ConfirmDialog: ({
      open,
      onConfirm,
      onCancel,
    }: {
      open: boolean;
      onConfirm?: () => void;
      onCancel?: () => void;
    }) =>
      open ? (
        <div>
          <button type="button" onClick={onConfirm}>
            Confirm
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null,
  };
});

const { client } = await import("@elizaos/ui");

afterEach(cleanup);

const calendarSummary: LifeOpsCalendarSummary = {
  provider: "eliza",
  side: "owner",
  grantId: "grant",
  connectorAccountId: "account",
  accountEmail: null,
  calendarId: "calendar",
  summary: "Primary",
  description: null,
  primary: true,
  accessRole: "owner",
  backgroundColor: null,
  foregroundColor: null,
  timeZone: "UTC",
  selected: true,
  includeInFeed: true,
  selectionVersion: 1,
};

function makeEvent(
  id: string,
  title: string,
  hour: number,
): LifeOpsCalendarEvent {
  return {
    id,
    externalId: `external-${id}`,
    agentId: "agent",
    provider: "eliza",
    side: "owner",
    calendarId: "calendar",
    grantId: "grant",
    title,
    description: "",
    location: "",
    status: "confirmed",
    startAt: new Date(2026, 9, 30, hour).toISOString(),
    endAt: new Date(2026, 9, 30, hour + 1).toISOString(),
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: { self: true, email: "owner@example.com" },
    attendees: [],
    metadata: { etag: "v1" },
    syncedAt: "2026-10-30T09:00:00Z",
    updatedAt: "2026-10-30T09:00:00Z",
  } as LifeOpsCalendarEvent;
}

const eventA = makeEvent("event-a", "Event A", 10);
const eventB = makeEvent("event-b", "Event B", 12);
const savedA: LifeOpsCalendarEvent = {
  ...eventA,
  title: "Event A renamed",
  metadata: { etag: "v2" },
  updatedAt: "2026-10-30T09:05:00Z",
};

const refresh = vi.fn(async () => {});

/**
 * Mirrors CalendarSection's wiring: one drawer instance is reused for every
 * event, onSaved swaps the drawer to the saved event, onClose clears it.
 */
function Harness() {
  const [drawerEvent, setDrawerEvent] = useState<LifeOpsCalendarEvent | null>(
    null,
  );
  return (
    <>
      <button type="button" onClick={() => setDrawerEvent(eventA)}>
        open-a
      </button>
      <button type="button" onClick={() => setDrawerEvent(eventB)}>
        open-b
      </button>
      <EventEditorDrawer
        open={drawerEvent !== null}
        mode="edit"
        event={drawerEvent}
        onClose={() => setDrawerEvent(null)}
        onSaved={(event) => {
          void refresh();
          setDrawerEvent(event);
        }}
        onDeleted={() => {
          void refresh();
          setDrawerEvent(null);
        }}
        onDataChanged={() => {
          void refresh();
        }}
      />
    </>
  );
}

describe("EventEditorDrawer stale save completion", () => {
  let resolveUpdate: (value: unknown) => void = () => {};
  const updateEvent = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
  );
  let resolveDelete: (value: unknown) => void = () => {};
  const deleteEvent = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
  );

  it("keeps the newer editing session when an earlier event's save lands late", async () => {
    const calendarClient = client as unknown as Record<string, unknown>;
    calendarClient.getLifeOpsCalendars = vi.fn(async () => ({
      calendars: [calendarSummary],
    }));
    calendarClient.updateLifeOpsCalendarEvent = updateEvent;

    render(<Harness />);

    // Open event A and start a save whose provider write stays in flight.
    fireEvent.click(screen.getByText("open-a"));
    const titleA = await screen.findByDisplayValue("Event A");
    expect(titleA).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() =>
      expect((saveButton as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(saveButton);
    expect(updateEvent).toHaveBeenCalledOnce();

    // Close the drawer mid-save through the header close button, then open
    // event B in the same drawer instance and start editing it.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByDisplayValue("Event A")).toBeNull();
    fireEvent.click(screen.getByText("open-b"));
    const titleB = await screen.findByDisplayValue("Event B");
    fireEvent.change(titleB, { target: { value: "Event B edited" } });
    expect(screen.getByDisplayValue("Event B edited")).toBeTruthy();

    // A's provider write finally resolves. The list may refresh, but the
    // late completion must not close or rewrite B's editing session.
    await act(async () => {
      resolveUpdate({ outcome: "updated", event: savedA });
    });
    expect(screen.getByDisplayValue("Event B edited")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps the newer editing session when an earlier event's delete lands late", async () => {
    const calendarClient = client as unknown as Record<string, unknown>;
    calendarClient.getLifeOpsCalendars = vi.fn(async () => ({
      calendars: [calendarSummary],
    }));
    calendarClient.deleteLifeOpsCalendarEvent = deleteEvent;

    render(<Harness />);

    // Open event A and confirm a delete whose provider write stays in
    // flight.
    fireEvent.click(screen.getByText("open-a"));
    await screen.findByDisplayValue("Event A");
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(deleteEvent).toHaveBeenCalledOnce();

    // Close the drawer mid-delete, then open event B and start editing it.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByDisplayValue("Event A")).toBeNull();
    fireEvent.click(screen.getByText("open-b"));
    const titleB = await screen.findByDisplayValue("Event B");
    fireEvent.change(titleB, { target: { value: "Event B edited" } });
    expect(screen.getByDisplayValue("Event B edited")).toBeTruthy();

    // A's delete finally resolves. The late completion must not close or
    // rewrite B's editing session.
    await act(async () => {
      resolveDelete({ outcome: "deleted", event: savedA });
    });
    expect(screen.getByDisplayValue("Event B edited")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });
});
