// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import { rankHomeNotifications } from "../../widgets/home-priority";
import { NotificationCenter } from "./NotificationCenter";

const mocks = vi.hoisted(() => ({
  appState: { setActionNotice: vi.fn() },
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

/**
 * Mixed-attention fixture. Distinct titles + createdAt so the two orderings are
 * unambiguous:
 *   - By priority (rankHomeNotifications): unread → priority → recency.
 *   - By time: strict newest-createdAt-first, ignoring read/priority.
 */
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;

function notif(
  id: string,
  title: string,
  opts: {
    priority: AgentNotification["priority"];
    createdAt: number;
    read?: boolean;
  },
): AgentNotification {
  return {
    id: id as AgentNotification["id"],
    title,
    category: "general",
    priority: opts.priority,
    source: "test",
    createdAt: opts.createdAt,
    readAt: opts.read ? opts.createdAt + 1_000 : null,
  };
}

// The store keeps newest-first insertion order, so ingest oldest → newest to
// leave "urgent-old" earliest and "read-newest" latest in raw store order —
// making both the priority sort and the time sort reorder the list distinctly.
const FIXTURE: AgentNotification[] = [
  notif("urgent-old", "Urgent but old", {
    priority: "urgent",
    createdAt: min(0),
  }),
  notif("normal-mid", "Normal middle", {
    priority: "normal",
    createdAt: min(10),
  }),
  notif("high-recent", "High and recent", {
    priority: "high",
    createdAt: min(20),
  }),
  notif("read-newest", "Read newest", {
    priority: "urgent",
    createdAt: min(30),
    read: true,
  }),
];

function seed(notifications: AgentNotification[]): void {
  mocks.listNotifications.mockResolvedValue({
    notifications,
    unreadCount: notifications.filter((n) => !n.readAt).length,
  });
  for (const item of notifications) {
    __ingestNotificationForTests(item, notifications.length);
  }
}

function renderedTitleOrder(): string[] {
  return Array.from(
    screen.getByTestId("notification-center-panel").querySelectorAll("ul > li"),
  ).map((li) => li.querySelector(".font-medium")?.textContent ?? "");
}

describe("NotificationCenter panel sort", () => {
  beforeEach(() => {
    __resetNotificationStoreForTests();
    mocks.appState.setActionNotice.mockReset();
    mocks.listNotifications
      .mockReset()
      .mockResolvedValue({ notifications: [], unreadCount: 0 });
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

  it("defaults to priority order (matching rankHomeNotifications) and toggles to newest-first", async () => {
    seed(FIXTURE);
    const user = userEvent.setup();
    render(<NotificationCenter isPanelMode />);

    await screen.findByTestId("notification-center-panel");

    // Default: attention-ranked. The store's raw order is newest-first
    // insertion, so assert against rankHomeNotifications applied to that.
    const rawStoreOrder = [...FIXTURE].reverse();
    const expectedPriority = rankHomeNotifications(rawStoreOrder).map(
      (n) => n.title,
    );
    expect(renderedTitleOrder()).toEqual(expectedPriority);
    // Sanity: the read urgent item is NOT first despite being urgent + newest —
    // unread wins in the priority ranking.
    expect(renderedTitleOrder()[0]).not.toBe("Read newest");

    // Toggle to time sort → strict newest-createdAt-first, ignoring read/priority.
    await user.click(screen.getByTestId("notification-sort-toggle"));
    expect(renderedTitleOrder()).toEqual([
      "Read newest",
      "High and recent",
      "Normal middle",
      "Urgent but old",
    ]);

    // Toggle back → priority order again.
    await user.click(screen.getByTestId("notification-sort-toggle"));
    expect(renderedTitleOrder()).toEqual(expectedPriority);
  });

  it("exposes a sort toggle whose aria-label reflects the current mode", async () => {
    seed(FIXTURE);
    const user = userEvent.setup();
    render(<NotificationCenter isPanelMode />);
    await screen.findByTestId("notification-center-panel");

    const toggle = screen.getByTestId("notification-sort-toggle");
    // Priority mode → offers to switch to time.
    expect(toggle.getAttribute("aria-label")).toMatch(/time/i);
    await user.click(toggle);
    // Time mode → offers to switch to priority.
    expect(toggle.getAttribute("aria-label")).toMatch(/priority/i);
  });

  it("renders a category icon on each row (panel mode)", async () => {
    seed(FIXTURE);
    render(<NotificationCenter isPanelMode />);
    await screen.findByTestId("notification-center-panel");

    const rows = screen
      .getByTestId("notification-center-panel")
      .querySelectorAll("ul > li");
    expect(rows.length).toBe(FIXTURE.length);
    // Each row's leading badge carries an SVG glyph (the category icon).
    for (const row of Array.from(rows)) {
      expect(row.querySelector("svg")).not.toBeNull();
    }
  });
});
