// @vitest-environment jsdom

/**
 * Exercises the accessible calendar source disclosure with real presentation
 * rows and deterministic hook state, including recovery and failed writes.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, ForwardedRef, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarSourcesResult } from "../hooks/useCalendarSources.js";

const sourceState = vi.hoisted(() => ({
  current: null as UseCalendarSourcesResult | null,
}));
const dispatchFocusConnector = vi.hoisted(() => vi.fn());
const dispatchNavigateViewEvent = vi.hoisted(() => vi.fn());

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
      <button ref={ref} type="button" {...props}>
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
  return { Button, Switch };
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

describe("CalendarSourceManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceState.current = defaultState();
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
});
