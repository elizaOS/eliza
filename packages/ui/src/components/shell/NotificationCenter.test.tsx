// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetNotificationShellForTests } from "../../state/notifications/notification-shell";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import { NotificationCenter } from "./NotificationCenter";

const mocks = vi.hoisted(() => ({
  appState: {
    setActionNotice: vi.fn(),
  },
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  removeNotification: vi.fn(),
  clearNotifications: vi.fn(),
  onWsEvent: vi.fn(),
  invokeDesktopBridgeRequest: vi.fn(),
  showNativeNotification: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof mocks.appState) => T): T =>
    selector(mocks.appState),
}));

vi.mock("../../api/client", () => ({
  client: {
    listNotifications: (...args: unknown[]) => mocks.listNotifications(...args),
    markNotificationRead: (...args: unknown[]) =>
      mocks.markNotificationRead(...args),
    markAllNotificationsRead: (...args: unknown[]) =>
      mocks.markAllNotificationsRead(...args),
    removeNotification: (...args: unknown[]) =>
      mocks.removeNotification(...args),
    clearNotifications: (...args: unknown[]) =>
      mocks.clearNotifications(...args),
    onWsEvent: (...args: unknown[]) => mocks.onWsEvent(...args),
  },
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: (...args: unknown[]) =>
    mocks.invokeDesktopBridgeRequest(...args),
}));

vi.mock("../../bridge/native-notifications", () => ({
  showNativeNotification: (...args: unknown[]) =>
    mocks.showNativeNotification(...args),
}));

function notification(
  id: string,
  title: string,
  category: AgentNotification["category"],
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: id as AgentNotification["id"],
    title,
    category,
    priority: "normal",
    source: "test",
    createdAt: Date.UTC(2026, 0, 1),
    readAt: null,
    ...overrides,
  };
}

/** Titles of the rendered notification rows, top-to-bottom. */
function renderedTitleOrder(titles: string[]): string[] {
  const list = screen.getByRole("list");
  const rows = Array.from(list.querySelectorAll("li")).map(
    (li) => li.textContent ?? "",
  );
  // Map each row back to whichever seeded title it contains, preserving order.
  return rows
    .map((text) => titles.find((t) => text.includes(t)) ?? "")
    .filter(Boolean);
}

function seedNotifications(notifications: AgentNotification[]): void {
  mocks.listNotifications.mockResolvedValue({
    notifications,
    unreadCount: notifications.length,
  });
  for (const item of notifications) {
    __ingestNotificationForTests(item, notifications.length);
  }
}

/**
 * jsdom ships no `window.matchMedia`, so `useMediaQuery` reads `false` for every
 * query by default. Install a deterministic stub whose `matches` is decided per
 * query — this is what selects the desktop panel vs the mobile pull-down sheet.
 */
function mockMatchMedia(matches: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

describe("NotificationCenter", () => {
  beforeEach(() => {
    // Default surface: coarse pointer / narrow viewport → mobile sheet shell.
    mockMatchMedia(() => false);
    __resetNotificationStoreForTests();
    __resetNotificationShellForTests();
    mocks.appState.setActionNotice.mockReset();
    mocks.listNotifications.mockReset().mockResolvedValue({
      notifications: [],
      unreadCount: 0,
    });
    mocks.markNotificationRead.mockReset().mockResolvedValue({ ok: true });
    mocks.markAllNotificationsRead
      .mockReset()
      .mockResolvedValue({ changed: 0 });
    mocks.removeNotification.mockReset().mockResolvedValue({ ok: true });
    mocks.clearNotifications.mockReset().mockResolvedValue({ ok: true });
    mocks.onWsEvent.mockReset();
    mocks.invokeDesktopBridgeRequest.mockReset().mockResolvedValue(null);
    mocks.showNativeNotification.mockReset().mockResolvedValue("none");
  });

  afterEach(() => {
    cleanup();
    __resetNotificationStoreForTests();
  });

  it("filters notification rows by category without losing the all view", async () => {
    seedNotifications([
      notification("reminder-1", "Take medication", "reminder"),
      notification("message-1", "Discord reply waiting", "message"),
      notification("system-1", "Update installed", "system"),
    ]);

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await screen.findByText("Take medication");
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();

    // Filter chips are toggle buttons (aria-pressed), scoped to the filter group.
    const filterBar = screen.getByRole("group", {
      name: "Filter notifications by category",
    });
    await user.click(
      within(filterBar).getByRole("button", { name: "Reminders" }),
    );
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).toBeNull();
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(within(filterBar).getByRole("button", { name: "All" }));
    expect(screen.queryByText("Take medication")).not.toBeNull();
    expect(screen.queryByText("Discord reply waiting")).not.toBeNull();
    expect(screen.queryByText("Update installed")).not.toBeNull();
  });

  it("falls back to all notifications when an active category disappears", async () => {
    seedNotifications([
      notification("reminder-1", "Take medication", "reminder"),
      notification("system-1", "Update installed", "system"),
    ]);

    const user = userEvent.setup();
    render(<NotificationCenter />);

    await user.click(screen.getByRole("button", { name: /notifications/i }));
    const filterBar = screen.getByRole("group", {
      name: "Filter notifications by category",
    });
    await user.click(
      within(filterBar).getByRole("button", { name: "Reminders" }),
    );
    expect(screen.queryByText("Update installed")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Take medication")).toBeNull();
      expect(screen.queryByText("Update installed")).not.toBeNull();
    });
    // The filter group collapses when only one category remains present.
    expect(
      screen.queryByRole("group", {
        name: "Filter notifications by category",
      }),
    ).toBeNull();
  });

  it("sheet variant: renders the panel controlled + closes via backdrop and grabber (#10706)", async () => {
    seedNotifications([notification("s1", "Pulled-down alert", "system")]);
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <NotificationCenter variant="sheet" open onOpenChange={onOpenChange} />,
    );

    // Open: the sheet + its panel content are visible without any bell click.
    expect(screen.getByTestId("notification-sheet")).toBeTruthy();
    await screen.findByText("Pulled-down alert");

    // Backdrop dismiss requests close.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("notification-sheet-backdrop"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    // The grabber also requests close (there is no close X — removed chrome).
    onOpenChange.mockClear();
    await user.click(screen.getByTestId("notification-sheet-grabber"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId("notification-sheet-close")).toBeNull();

    // Closed: nothing renders (controlled).
    rerender(
      <NotificationCenter
        variant="sheet"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
  });

  it("defaults to priority sort and toggles to a most-recent-first timeline (#10706)", async () => {
    const TITLES = ["Older high", "Newest normal", "Oldest urgent"];
    seedNotifications([
      notification("a", "Older high", "system", {
        priority: "high",
        createdAt: Date.UTC(2026, 0, 2),
      }),
      notification("b", "Newest normal", "system", {
        priority: "normal",
        createdAt: Date.UTC(2026, 0, 3),
      }),
      notification("c", "Oldest urgent", "system", {
        priority: "urgent",
        createdAt: Date.UTC(2026, 0, 1),
      }),
    ]);

    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.click(screen.getByRole("button", { name: /notifications/i }));
    await screen.findByText("Older high");

    // Default = Priority: unread → priority → recency → urgent, then high, then normal.
    expect(
      screen.getByTestId("notif-sort-priority").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(renderedTitleOrder(TITLES)).toEqual([
      "Oldest urgent",
      "Older high",
      "Newest normal",
    ]);

    // Flip to Recent: pure most-recent-first, priority ignored.
    await user.click(screen.getByTestId("notif-sort-time"));
    expect(
      screen.getByTestId("notif-sort-time").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(renderedTitleOrder(TITLES)).toEqual([
      "Newest normal",
      "Older high",
      "Oldest urgent",
    ]);
  });

  it("headless opens the sheet on OPEN_NOTIFICATION_CENTER_EVENT and closes on backdrop (#10706)", async () => {
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    seedNotifications([notification("n1", "Payment failed", "system")]);
    const user = userEvent.setup();

    // The headless instance renders nothing until the surface-agnostic open
    // event fires (the desktop-native "Notifications" menu/tray + the
    // <scheme>://notifications deep link dispatch it).
    render(<NotificationCenter headless />);
    expect(screen.queryByTestId("notification-sheet")).toBeNull();

    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));

    await waitFor(() => {
      expect(screen.getByTestId("notification-sheet")).toBeTruthy();
    });
    // The seeded notification is visible in the opened sheet.
    expect(screen.getByText("Payment failed")).toBeTruthy();

    // Backdrop dismiss closes it again.
    await user.click(screen.getByTestId("notification-sheet-backdrop"));
    await waitFor(() => {
      expect(screen.queryByTestId("notification-sheet")).toBeNull();
    });
  });

  it("desktop surface: OPEN event reveals the anchored panel, not the pull-down sheet", async () => {
    // Fine pointer + wide viewport → desktop/web panel shell.
    mockMatchMedia((q) => q.includes("pointer: fine"));
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    seedNotifications([notification("d1", "Deploy finished", "system")]);

    render(<NotificationCenter headless />);
    expect(screen.queryByTestId("notification-panel")).toBeNull();

    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));

    await waitFor(() => {
      expect(screen.getByTestId("notification-panel")).toBeTruthy();
    });
    // The desktop shell is the panel — never the mobile pull-down sheet.
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
    expect(screen.getByText("Deploy finished")).toBeTruthy();
    // No close X — dismissal is via the outside/backdrop click (covered below).
    expect(screen.queryByTestId("notification-panel-close")).toBeNull();
  });

  it("desktop panel: dismisses on an outside (backdrop) click", async () => {
    mockMatchMedia((q) => q.includes("pointer: fine"));
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    seedNotifications([notification("d1", "Deploy finished", "system")]);
    const user = userEvent.setup();

    render(<NotificationCenter headless />);
    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));
    await screen.findByTestId("notification-panel");

    await user.click(screen.getByTestId("notification-panel-backdrop"));
    await waitFor(() => {
      expect(screen.queryByTestId("notification-panel")).toBeNull();
    });
  });

  it('variant="auto": a controlled caller renders the desktop panel on a fine-pointer surface', async () => {
    // Fine pointer + wide viewport → the panel shell (this is HomeScreen's
    // notification affordance path: controlled open, surface-picked shell).
    mockMatchMedia((q) => q.includes("pointer: fine"));
    seedNotifications([notification("a1", "Auto desktop alert", "system")]);
    render(<NotificationCenter variant="auto" open onOpenChange={() => {}} />);

    await screen.findByTestId("notification-panel");
    expect(screen.queryByTestId("notification-sheet")).toBeNull();
    expect(screen.getByText("Auto desktop alert")).toBeTruthy();
  });

  it('variant="auto": a controlled caller renders the pull-down sheet on a coarse surface', async () => {
    // Coarse pointer / narrow viewport (beforeEach default) → the sheet shell.
    seedNotifications([notification("a2", "Auto mobile alert", "reminder")]);
    render(<NotificationCenter variant="auto" open onOpenChange={() => {}} />);

    await screen.findByTestId("notification-sheet");
    expect(screen.queryByTestId("notification-panel")).toBeNull();
    expect(screen.getByText("Auto mobile alert")).toBeTruthy();
  });

  it("mobile surface: OPEN event reveals the pull-down sheet, not the desktop panel", async () => {
    // Coarse pointer / narrow viewport → mobile sheet shell (beforeEach default,
    // set explicitly here for clarity).
    mockMatchMedia(() => false);
    const { OPEN_NOTIFICATION_CENTER_EVENT } = await import("../../events");
    seedNotifications([notification("m1", "Reminder due", "reminder")]);

    render(<NotificationCenter headless />);
    window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATION_CENTER_EVENT));

    await waitFor(() => {
      expect(screen.getByTestId("notification-sheet")).toBeTruthy();
    });
    expect(screen.queryByTestId("notification-panel")).toBeNull();
    expect(screen.getByText("Reminder due")).toBeTruthy();
  });

  it("controlled shells are accessible dialogs: aria-modal, focus moves in, focus returns on close", async () => {
    seedNotifications([notification("f1", "Focus me", "system")]);
    const Harness = ({ open }: { open: boolean }) => (
      <>
        <button type="button" data-testid="opener">
          open
        </button>
        <NotificationCenter
          variant="sheet"
          open={open}
          onOpenChange={() => {}}
        />
      </>
    );
    // Start closed with the opener focused (the real flow: a trigger opens it).
    const { rerender } = render(<Harness open={false} />);
    (screen.getByTestId("opener") as HTMLElement).focus();
    expect(document.activeElement).toBe(screen.getByTestId("opener"));

    // Open: the effect captures the opener and moves focus into the dialog.
    rerender(<Harness open />);
    const dialog = screen.getByTestId("notification-sheet");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    // Close: focus returns to the opener.
    rerender(<Harness open={false} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("opener")),
    );
  });

  it("empty state waits for hydration: shows Loading… before the inbox settles, then 'all caught up'", async () => {
    const { __setHydratedForTests } = await import(
      "../../state/notifications/notification-store"
    );
    // Keep the store's own hydrate() pending so `hydrated` stays false after mount.
    mocks.listNotifications.mockReturnValue(new Promise(() => {}));

    render(<NotificationCenter variant="sheet" open onOpenChange={() => {}} />);
    // Not hydrated + no rows → neutral loading, NOT the definitive empty copy.
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("You're all caught up")).toBeNull();

    // Hydration settles empty → the definitive empty state replaces Loading….
    __setHydratedForTests(true);
    await waitFor(() =>
      expect(screen.getByText("You're all caught up")).toBeTruthy(),
    );
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("category filter chips are toggle buttons (aria-pressed), not fake tabs", async () => {
    seedNotifications([
      notification("c1", "A reminder", "reminder"),
      notification("c2", "A message", "message"),
    ]);
    const user = userEvent.setup();
    render(<NotificationCenter variant="sheet" open onOpenChange={() => {}} />);
    await screen.findByText("A reminder");

    // No ARIA tabs machinery (which would promise arrow-key nav we don't ship).
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();

    const filterBar = screen.getByRole("group", {
      name: "Filter notifications by category",
    });
    const remindersChip = within(filterBar).getByRole("button", {
      name: "Reminders",
    });
    expect(remindersChip.getAttribute("aria-pressed")).toBe("false");
    await user.click(remindersChip);
    expect(remindersChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("Android back closes the open controlled shell and marks the intent handled", async () => {
    const { ELIZA_BACK_INTENT_EVENT } = await import("../../events");
    seedNotifications([notification("b1", "Back me", "system")]);
    const onOpenChange = vi.fn();
    render(
      <NotificationCenter variant="sheet" open onOpenChange={onOpenChange} />,
    );
    await screen.findByTestId("notification-sheet");

    const detail = { handled: false };
    window.dispatchEvent(new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }));
    // The shell claimed back (so the chat/native fall-through won't also fire)…
    expect(detail.handled).toBe(true);
    // …and requested its own close.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Android back does nothing when no shell is open", async () => {
    const { ELIZA_BACK_INTENT_EVENT } = await import("../../events");
    seedNotifications([notification("b2", "Idle", "system")]);
    const onOpenChange = vi.fn();
    render(
      <NotificationCenter
        variant="sheet"
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    const detail = { handled: false };
    window.dispatchEvent(new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }));
    // Closed shell registers no handler → back stays unhandled for other layers.
    expect(detail.handled).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Escape defers to a stacked open Radix dialog (peels one layer per press)", async () => {
    seedNotifications([notification("e1", "Stacked", "system")]);
    const onOpenChange = vi.fn();
    // A Radix-style dialog painted on top of the panel.
    render(
      <>
        <div role="dialog" data-state="open" data-testid="stacked-dialog">
          command palette
        </div>
        <NotificationCenter variant="panel" open onOpenChange={onOpenChange} />
      </>,
    );
    await screen.findByTestId("notification-panel");

    fireEvent.keyDown(window, { key: "Escape" });
    // The topmost Radix layer consumes this Escape; the panel stays open.
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
