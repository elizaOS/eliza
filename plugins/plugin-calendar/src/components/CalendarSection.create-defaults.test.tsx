// @vitest-environment jsdom

import type { LifeOpsCalendarSummary } from "@elizaos/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarSection } from "./CalendarSection";

// These tests render the real CalendarSection host with the real
// EventEditorDrawer, because the wiring under test is the host passing
// create defaults to the create-mode drawer. As in
// EventEditorDrawer.stale-completion.test.tsx, the @elizaos/ui leaf
// primitives and store are stubbed at the module boundary (the checkout
// has no built @elizaos/host dist, so the real UI index cannot resolve
// here). The week feed hook and the workspace are stubbed the same way;
// the drawers and the section's own state and effects are the real code.
const viewEventHandlers = vi.hoisted(() => new Map<string, () => void>());

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
    VIEW_EVENTS: { VIEW_REFRESH: "view-refresh" },
    useViewEvent: (event: string, handler: () => void) => {
      viewEventHandlers.set(event, handler);
    },
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

// A completed feed fetch returns a fresh events array, which is what
// re-renders CalendarSection in the app while a drawer is open. The stub
// hook models exactly that: refresh swaps in a new array identity.
vi.mock("../hooks/useCalendarWeek.js", async () => {
  const React = await import("react");
  return {
    useCalendarWeek: () => {
      const [events, setEvents] = React.useState<unknown[]>([]);
      const refresh = React.useCallback(async () => {
        setEvents((prev) => [...prev]);
      }, []);
      return {
        events,
        feedState: "complete",
        sources: [],
        status: "ready",
        loading: false,
        refreshing: false,
        issue: null,
        error: null,
        viewMode: "week",
        setViewMode: () => {},
        baseDate: new Date(2026, 9, 30),
        windowStart: new Date(2026, 9, 26),
        windowEnd: new Date(2026, 10, 1),
        refresh,
        goToDate: () => {},
        goToToday: () => {},
        goPrevious: () => {},
        goNext: () => {},
      };
    },
  };
});

// The workspace stub exposes the two create launches CalendarSection
// wires to onCreateEvent: pick a day, and the section stores that date
// as the create default and opens the create drawer.
vi.mock("./CalendarWorkspace.js", async () => {
  return {
    CalendarWorkspace: ({
      onCreateEvent,
    }: {
      onCreateEvent: (date: Date) => void;
    }) => (
      <div>
        <button
          type="button"
          onClick={() => onCreateEvent(new Date(2026, 9, 30, 9, 10))}
        >
          ws-create-oct30
        </button>
        <button
          type="button"
          onClick={() => onCreateEvent(new Date(2026, 10, 5, 9, 10))}
        >
          ws-create-nov5
        </button>
      </div>
    ),
  };
});

const { client, VIEW_EVENTS } = await import("@elizaos/ui");

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

function renderSection() {
  const calendarClient = client as unknown as Record<string, unknown>;
  calendarClient.getLifeOpsCalendars = vi.fn(async () => ({
    calendars: [calendarSummary],
  }));
  return render(
    <CalendarSection
      selectedEventId={null}
      onSelectEvent={() => {}}
      getPrimedEvent={() => null}
    />,
  );
}

// A view refresh makes the section's feed hook fetch again; when the
// fetch lands, the section re-renders with a new events array.
async function dispatchViewRefresh() {
  const handler = viewEventHandlers.get(VIEW_EVENTS.VIEW_REFRESH);
  expect(handler).toBeDefined();
  await act(async () => {
    handler?.();
  });
}

function startTimeInput(): HTMLInputElement {
  return screen.getByLabelText("Start time") as HTMLInputElement;
}

describe("CalendarSection create defaults", () => {
  it("keeps typed input when the host re-renders during an open create", async () => {
    renderSection();

    // Launch a create for Oct 30 and type into the form.
    fireEvent.click(screen.getByText("ws-create-oct30"));
    const title = await screen.findByPlaceholderText("Event title");
    expect(startTimeInput().value).toBe("2026-10-30T09:30");
    fireEvent.change(title, { target: { value: "Dentist draft" } });
    expect(screen.getByDisplayValue("Dentist draft")).toBeTruthy();

    // A background feed refresh lands and re-renders the section while
    // the create drawer is still open. Nothing about the create session
    // changed, so the typed input and the seeded start must survive.
    await dispatchViewRefresh();
    expect(screen.getByDisplayValue("Dentist draft")).toBeTruthy();
    expect(startTimeInput().value).toBe("2026-10-30T09:30");
  });

  it("seeds fresh defaults for a genuinely new create session", async () => {
    renderSection();

    // First session: Oct 30 defaults, some typed input, then close.
    fireEvent.click(screen.getByText("ws-create-oct30"));
    const firstTitle = await screen.findByPlaceholderText("Event title");
    fireEvent.change(firstTitle, { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByPlaceholderText("Event title")).toBeNull();

    // Second session, launched for Nov 5: the form must seed blank with
    // the new date, not restore the first session's draft.
    fireEvent.click(screen.getByText("ws-create-nov5"));
    const secondTitle = await screen.findByPlaceholderText("Event title");
    expect((secondTitle as HTMLInputElement).value).toBe("");
    expect(startTimeInput().value).toBe("2026-11-05T09:30");

    // And the new session's own typing survives a host re-render too.
    fireEvent.change(secondTitle, { target: { value: "Second draft" } });
    await dispatchViewRefresh();
    expect(screen.getByDisplayValue("Second draft")).toBeTruthy();
    expect(startTimeInput().value).toBe("2026-11-05T09:30");
  });
});
