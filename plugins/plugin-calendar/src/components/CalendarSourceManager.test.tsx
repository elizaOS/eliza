// @vitest-environment jsdom

/**
 * Exercises the accessible calendar source disclosure with real presentation
 * rows and deterministic hook state, including recovery, failed writes, and
 * ICS subscription create/remove against a spied calendar client.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsIcsCalendarSource,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  ForwardedRef,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarSourcesResult } from "../hooks/useCalendarSources.js";

const sourceState = vi.hoisted(() => ({
  current: null as UseCalendarSourcesResult | null,
}));
const dispatchFocusConnector = vi.hoisted(() => vi.fn());
const dispatchNavigateViewEvent = vi.hoisted(() => vi.fn());

const uiClient = vi.hoisted(() => ({
  getLifeOpsIcsCalendarSources: vi.fn(),
  createLifeOpsIcsCalendarSource: vi.fn(),
  deleteLifeOpsIcsCalendarSource: vi.fn(),
  syncLifeOpsIcsCalendarSource: vi.fn(),
}));

vi.mock("../hooks/useCalendarSources.js", () => ({
  useCalendarSources: () => sourceState.current,
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

vi.mock("@elizaos/ui/events", () => ({
  dispatchFocusConnector,
  dispatchNavigateViewEvent,
}));

const appValue = vi.hoisted(() => ({
  t: (key: string, opts?: Record<string, unknown>) => {
    const template =
      typeof opts?.defaultValue === "string" ? opts.defaultValue : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
      String(opts?.[name] ?? ""),
    );
  },
}));

vi.mock("@elizaos/ui/state", () => ({
  useAppSelector: <T,>(selector: (value: typeof appValue) => T) =>
    selector(appValue),
}));

// The component imports `../api/client-calendar.js` for its side effect, which
// augments `ElizaClient.prototype`; provide a throwaway class so that import
// resolves while tests exercise the spied `client` object.
vi.mock("@elizaos/ui", () => ({
  ElizaClient: class {},
}));

vi.mock("@elizaos/ui/api", () => ({
  client: uiClient,
  ElizaClient: class {},
}));

vi.mock("@elizaos/ui/components", async () => {
  const React = await import("react");
  const Button = React.forwardRef(
    (
      {
        children,
        unstyled: _unstyled,
        ...props
      }: ButtonHTMLAttributes<HTMLButtonElement> & {
        children?: ReactNode;
        unstyled?: boolean;
      },
      ref: ForwardedRef<HTMLButtonElement>,
    ) => (
      <button
        ref={ref}
        type={props.type === "submit" ? "submit" : "button"}
        {...props}
      >
        {children}
      </button>
    ),
  );
  const Switch = React.forwardRef(
    (
      {
        checked,
        onCheckedChange,
        ...props
      }: ButtonHTMLAttributes<HTMLButtonElement> & {
        checked?: boolean;
        onCheckedChange?: (checked: boolean) => void;
      },
      ref: ForwardedRef<HTMLButtonElement>,
    ) => (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange?.(!checked)}
        {...props}
      />
    ),
  );
  const Input = React.forwardRef(
    (
      props: InputHTMLAttributes<HTMLInputElement>,
      ref: ForwardedRef<HTMLInputElement>,
    ) => <input ref={ref} {...props} />,
  );
  const ConfirmDialog = ({
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
        <button type="button" data-testid="confirm-remove" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
    ) : null;
  return { Button, Switch, Input, ConfirmDialog };
});

import { CalendarSourceManager } from "./CalendarSourceManager.js";

function calendar(
  over: Partial<LifeOpsCalendarSummary> = {},
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: "owner",
    grantId: "grant-work",
    connectorAccountId: "account-work",
    accountEmail: "work@example.com",
    calendarId: "primary",
    summary: "Work",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
    ...over,
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
    syncedAt: new Date().toISOString(),
    error: null,
    ...over,
  };
}

function defaultState(
  over: Partial<UseCalendarSourcesResult> = {},
): UseCalendarSourcesResult {
  return {
    calendars: [
      calendar(),
      calendar({
        provider: "microsoft",
        grantId: "grant-family",
        connectorAccountId: "account-family",
        accountEmail: "family@example.com",
        calendarId: "family",
        summary: "Family",
        primary: false,
        accessRole: "reader",
        includeInFeed: false,
      }),
    ],
    status: "ready",
    loading: false,
    refreshing: false,
    error: null,
    refreshError: null,
    pendingKeys: new Set(),
    mutationErrors: {},
    refresh: vi.fn(async () => {}),
    setIncluded: vi.fn(async () => "updated"),
    ...over,
  };
}

const mixedHealth: LifeOpsCalendarSourceHealth[] = [
  source(),
  source({
    key: {
      provider: "google",
      side: "owner",
      grantId: "grant-retired",
      connectorAccountId: "account-retired",
      calendarId: "travel",
    },
    summary: "Travel",
    accessRole: "reader",
    visibility: "busy_only",
    status: "disconnected",
    syncedAt: null,
  }),
  source({
    key: {
      provider: "microsoft",
      side: "owner",
      grantId: "grant-old-outlook",
      connectorAccountId: "account-old-outlook",
      calendarId: "archive",
    },
    summary: "Archive",
    accessRole: "freeBusyReader",
    visibility: "busy_only",
    status: "disconnected",
    syncedAt: null,
  }),
];

function icsSource(
  over: Partial<LifeOpsIcsCalendarSource> = {},
): LifeOpsIcsCalendarSource {
  return {
    id: "ics-source-1",
    provider: "ics",
    name: "Team holidays",
    enabled: true,
    origin: "https://feeds.example.com",
    urlFingerprint: "fp-1",
    syncStatus: "fresh",
    lastSyncedAt: "2026-07-26T12:00:00.000Z",
    lastAttemptedAt: "2026-07-26T12:00:00.000Z",
    error: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-26T12:00:00.000Z",
    ...over,
  };
}

describe("CalendarSourceManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceState.current = defaultState();
    uiClient.getLifeOpsIcsCalendarSources.mockResolvedValue({ sources: [] });
  });

  afterEach(() => cleanup());

  it("uses a collapsed disclosure and exposes complete source identity on demand", () => {
    const { container } = render(
      <CalendarSourceManager sourceHealth={mixedHealth} />,
    );
    const manage = screen.getByRole("button", {
      name: "Manage calendar sources",
    });
    expect(manage.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByText(/New calendars are included automatically/),
    ).toBeNull();

    fireEvent.click(manage);

    expect(manage.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByText(/New calendars are included automatically/),
    ).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText(/Google Calendar · work@example.com/)).toBeTruthy();
    expect(screen.getByText(/Owner · Event details ·/)).toBeTruthy();
    expect(screen.getByText("Family")).toBeTruthy();
    expect(
      screen.getByText(/Microsoft Outlook · family@example.com/),
    ).toBeTruthy();
    expect(screen.getByText(/Not in current feed/)).toBeTruthy();
    expect(screen.getByText("Travel")).toBeTruthy();
    expect(screen.getByText(/Reconnect Google Calendar/)).toBeTruthy();
    expect(screen.getByText("Reconnect unavailable here.")).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(container.innerHTML).not.toContain("grant-retired");
    expect(container.innerHTML).not.toContain("account-retired");
  });

  it("sends the exact calendar identity and refreshes feed truth after success", async () => {
    const onSelectionChanged = vi.fn();
    render(
      <CalendarSourceManager
        sourceHealth={mixedHealth}
        onSelectionChanged={onSelectionChanged}
        defaultOpen
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: /Include Work .* in the combined calendar/,
    });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(sourceState.current?.setIncluded).toHaveBeenCalledWith(
        sourceState.current?.calendars[0],
        false,
      ),
    );
    expect(onSelectionChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending switch disabled and renders row-level failure separately", () => {
    const work = sourceState.current?.calendars[0];
    if (!work) throw new Error("missing work fixture");
    const key = JSON.stringify([
      work.provider,
      work.side,
      work.grantId,
      work.connectorAccountId,
      work.calendarId,
    ]);
    sourceState.current = defaultState({
      pendingKeys: new Set([key]),
      mutationErrors: {
        [key]: "Couldn’t exclude “Work”. Your current setting was kept.",
      },
    });

    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);

    const toggle = screen.getByRole("switch", {
      name: /Include Work .* in the combined calendar/,
    });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Excluding…")).toBeTruthy();
    expect(
      screen
        .getByText("Couldn’t exclude “Work”. Your current setting was kept.")
        .getAttribute("role"),
    ).toBe("alert");
  });

  it("renders loading, error/retry, and authoritative empty as distinct states", () => {
    sourceState.current = defaultState({
      calendars: [],
      status: "loading",
      loading: true,
    });
    const { rerender } = render(
      <CalendarSourceManager sourceHealth={[]} defaultOpen />,
    );
    expect(
      screen.getByText("Loading calendar sources…").getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByText("No calendar sources were found.")).toBeNull();

    sourceState.current = defaultState({
      calendars: [],
      status: "error",
      error: "Calendar sources could not load.",
    });
    rerender(<CalendarSourceManager sourceHealth={[]} defaultOpen />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar sources could not load.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(sourceState.current.refresh).toHaveBeenCalledTimes(1);

    sourceState.current = defaultState({
      calendars: [],
      status: "empty",
    });
    rerender(<CalendarSourceManager sourceHealth={[]} defaultOpen />);
    expect(screen.getByText("No calendar sources were found.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open connector settings" }),
    ).toBeTruthy();
  });

  it("routes only registered Google recovery through the safe settings handoff", () => {
    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);

    fireEvent.click(
      screen.getByRole("button", { name: "Reconnect Google Calendar" }),
    );

    expect(dispatchFocusConnector).toHaveBeenCalledWith("google");
    expect(dispatchNavigateViewEvent).toHaveBeenCalledWith({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors",
    });
    expect(dispatchFocusConnector.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchNavigateViewEvent.mock.invocationCallOrder[0],
    );
    expect(screen.getByText("Reconnect unavailable here.")).toBeTruthy();
  });

  it("opens connector settings without inventing a provider focus for empty state", () => {
    sourceState.current = defaultState({
      calendars: [],
      status: "empty",
    });
    render(<CalendarSourceManager sourceHealth={[]} defaultOpen />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open connector settings" }),
    );

    expect(dispatchFocusConnector).not.toHaveBeenCalled();
    expect(dispatchNavigateViewEvent).toHaveBeenCalledWith({
      viewId: "settings",
      viewPath: "/settings",
      subview: "connectors",
    });
  });

  it("lists ICS subscriptions with sync truth and distinguishes error rows", async () => {
    uiClient.getLifeOpsIcsCalendarSources.mockResolvedValue({
      sources: [
        icsSource(),
        icsSource({
          id: "ics-source-2",
          name: "Broken feed",
          origin: "https://broken.example.com",
          syncStatus: "error",
          error: {
            code: "ICS_FETCH_FAILED",
            message: "Feed returned 404.",
            retryable: true,
          },
        }),
      ],
    });

    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);

    await waitFor(() => expect(screen.getByText("Team holidays")).toBeTruthy());
    expect(screen.getByText(/Synced/)).toBeTruthy();
    expect(screen.getByText("Broken feed")).toBeTruthy();
    expect(screen.getByText(/Feed returned 404\./)).toBeTruthy();
  });

  it("renders a designed error state with retry when the subscription list fails", async () => {
    uiClient.getLifeOpsIcsCalendarSources
      .mockRejectedValueOnce(new Error("subscriptions boom"))
      .mockResolvedValueOnce({ sources: [icsSource()] });

    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);

    await waitFor(() =>
      expect(screen.getByText("subscriptions boom")).toBeTruthy(),
    );
    expect(screen.queryByText("No calendar subscriptions yet.")).toBeNull();

    const alert = screen
      .getByText("subscriptions boom")
      .closest("[role='alert']") as HTMLElement;
    fireEvent.click(
      Array.from(alert.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry",
      ) as HTMLButtonElement,
    );

    await waitFor(() => expect(screen.getByText("Team holidays")).toBeTruthy());
  });

  it("subscribes with name and URL, triggers the first sync, and refreshes feed truth", async () => {
    const onSelectionChanged = vi.fn();
    const created = icsSource({ id: "ics-new", name: "Race calendar" });
    uiClient.getLifeOpsIcsCalendarSources
      .mockResolvedValueOnce({ sources: [] })
      .mockResolvedValueOnce({ sources: [created] });
    uiClient.createLifeOpsIcsCalendarSource.mockResolvedValue({
      source: created,
    });
    uiClient.syncLifeOpsIcsCalendarSource.mockResolvedValue({
      source: created,
      outcome: "complete",
      acceptedEvents: 4,
      prunedEvents: 0,
      tombstones: 0,
    });

    render(
      <CalendarSourceManager
        sourceHealth={mixedHealth}
        onSelectionChanged={onSelectionChanged}
        defaultOpen
      />,
    );
    await waitFor(() =>
      expect(screen.getByText("No calendar subscriptions yet.")).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Subscription name"), {
      target: { value: "  Race calendar  " },
    });
    fireEvent.change(screen.getByLabelText("Subscription URL"), {
      target: { value: " https://feeds.example.com/races.ics " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() =>
      expect(uiClient.createLifeOpsIcsCalendarSource).toHaveBeenCalledWith({
        name: "Race calendar",
        url: "https://feeds.example.com/races.ics",
      }),
    );
    await waitFor(() =>
      expect(uiClient.syncLifeOpsIcsCalendarSource).toHaveBeenCalledWith(
        "ics-new",
      ),
    );
    await waitFor(() => expect(screen.getByText("Race calendar")).toBeTruthy());
    expect(onSelectionChanged).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByLabelText("Subscription name") as HTMLInputElement).value,
    ).toBe("");
  });

  it("keeps the entered name and URL visible when subscribing fails", async () => {
    uiClient.createLifeOpsIcsCalendarSource.mockRejectedValue(
      new Error("URL must use https or webcal."),
    );

    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);
    await waitFor(() =>
      expect(uiClient.getLifeOpsIcsCalendarSources).toHaveBeenCalled(),
    );

    fireEvent.change(screen.getByLabelText("Subscription name"), {
      target: { value: "Bad feed" },
    });
    fireEvent.change(screen.getByLabelText("Subscription URL"), {
      target: { value: "ftp://nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() =>
      expect(screen.getByText("URL must use https or webcal.")).toBeTruthy(),
    );
    expect(
      (screen.getByLabelText("Subscription name") as HTMLInputElement).value,
    ).toBe("Bad feed");
    expect(uiClient.syncLifeOpsIcsCalendarSource).not.toHaveBeenCalled();
  });

  it("removes a subscription only after confirmation and refreshes feed truth", async () => {
    const onSelectionChanged = vi.fn();
    uiClient.getLifeOpsIcsCalendarSources
      .mockResolvedValueOnce({ sources: [icsSource()] })
      .mockResolvedValueOnce({ sources: [] });
    uiClient.deleteLifeOpsIcsCalendarSource.mockResolvedValue({
      deleted: true,
    });

    render(
      <CalendarSourceManager
        sourceHealth={mixedHealth}
        onSelectionChanged={onSelectionChanged}
        defaultOpen
      />,
    );
    await waitFor(() => expect(screen.getByText("Team holidays")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove subscription Team holidays",
      }),
    );
    expect(uiClient.deleteLifeOpsIcsCalendarSource).not.toHaveBeenCalled();
    expect(screen.getByTestId("confirm-dialog").textContent).toContain(
      "Team holidays",
    );

    fireEvent.click(screen.getByTestId("confirm-remove"));

    await waitFor(() =>
      expect(uiClient.deleteLifeOpsIcsCalendarSource).toHaveBeenCalledWith(
        "ics-source-1",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("No calendar subscriptions yet.")).toBeTruthy(),
    );
    expect(onSelectionChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps a subscription listed with a visible error when removal fails", async () => {
    uiClient.getLifeOpsIcsCalendarSources.mockResolvedValue({
      sources: [icsSource()],
    });
    uiClient.deleteLifeOpsIcsCalendarSource.mockRejectedValue(
      new Error("removal boom"),
    );

    render(<CalendarSourceManager sourceHealth={mixedHealth} defaultOpen />);
    await waitFor(() => expect(screen.getByText("Team holidays")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove subscription Team holidays",
      }),
    );
    fireEvent.click(screen.getByTestId("confirm-remove"));

    await waitFor(() => expect(screen.getByText("removal boom")).toBeTruthy());
    expect(screen.getByText("Team holidays")).toBeTruthy();
  });
});
