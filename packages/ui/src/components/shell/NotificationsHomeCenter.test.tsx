// @vitest-environment jsdom

// Dashboard notification center behavior against the real notification store
// (driven via the test-only ingest; HTTP mutations mocked at the API client).
// Pins the shade spec: priority-only triage, liquid-glass Z-stacked groups
// with no headers/dividers, DIRECTIONAL pull/wheel expand-collapse (down
// expands, up collapses — never a toggle, so trailing trackpad momentum can't
// snap the shade back shut), a passive notification total, direct-tap
// activation, and swipe-to-dismiss.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutations are optimistic writes through the API client - mock the transport,
// not the store, so mark-read/dismiss/clear exercise the real store paths.
vi.mock("../../api/client", () => ({
  client: {
    listNotifications: vi.fn(async () => ({
      notifications: [],
      unreadCount: 0,
    })),
    onWsEvent: vi.fn(),
    markNotificationRead: vi.fn(async () => ({})),
    markAllNotificationsRead: vi.fn(async () => ({})),
    removeNotification: vi.fn(async () => ({})),
    clearNotifications: vi.fn(async () => ({})),
  },
}));

const navigateDeepLink = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink,
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __getStateForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../state/notifications/notification-store";
import {
  dampenPull,
  groupDashboardNotifications,
  NotificationsHomeCenter,
  notificationGroupKey,
  notificationGroupLabel,
  notificationPullRevealProgress,
  orderDashboardNotifications,
  PULL_COMMIT_PX,
} from "./NotificationsHomeCenter";

let seq = 0;
function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  seq += 1;
  const hex = String(seq).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}` as AgentNotification["id"],
    title: `Notification ${seq}`,
    category: "general",
    // High by default so fixtures render in the rested (interrupt-only) shade;
    // filter tests override to normal/low explicitly.
    priority: "high",
    source: "test",
    createdAt: 1_700_000_000_000 + seq * 1000,
    readAt: null,
    ...overrides,
  };
}

function expandShade(): HTMLElement {
  const list = screen.getByTestId("home-notification-list");
  fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
  return list;
}

function collapseShade(): HTMLElement {
  const list = screen.getByTestId("home-notification-list");
  fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
  fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
  return list;
}

function setOverflowingListGeometry(list: HTMLElement): void {
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 900 },
    clientHeight: { configurable: true, value: 300 },
    scrollTop: { configurable: true, value: 120, writable: true },
  });
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 300,
    bottom: 500,
    left: 0,
    width: 300,
    height: 500,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  seq = 0;
});

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  navigateDeepLink.mockClear();
});

describe("orderDashboardNotifications", () => {
  it("orders by priority bucket then recency, ignoring read state", () => {
    const low = makeNotification({ priority: "low" });
    const urgentOld = makeNotification({
      priority: "urgent",
      createdAt: 1_600_000_000_000,
      readAt: 1_600_000_500_000, // read - must NOT sink below unread lows
    });
    const normalNew = makeNotification({ priority: "normal" });
    const ordered = orderDashboardNotifications([low, urgentOld, normalNew]);
    expect(ordered.map((n) => n.id)).toEqual([
      urgentOld.id,
      normalNew.id,
      low.id,
    ]);
  });

  it("is a stable total order (id tiebreak) so equal rows never reshuffle", () => {
    const a = makeNotification({ createdAt: 5 });
    const b = makeNotification({ createdAt: 5 });
    const once = orderDashboardNotifications([a, b]).map((n) => n.id);
    const twice = orderDashboardNotifications([b, a]).map((n) => n.id);
    expect(once).toEqual(twice);
  });

  it("is priority-only: there is no alternate sort mode parameter", () => {
    // Regression for the removed priority/recent toggle: the order function
    // takes exactly one argument — the shade cannot be put into a "recent"
    // mode at all.
    expect(orderDashboardNotifications.length).toBe(1);
  });
});

describe("notification producer grouping", () => {
  it("keeps one producer together across categories and separates different producers that open the same view", () => {
    const approval = makeNotification({
      category: "approval",
      deepLink: "/tasks",
      source: " LifeOps ",
    });
    const reminder = makeNotification({
      category: "reminder",
      deepLink: "/automations",
      source: "lifeops",
    });
    const scheduler = makeNotification({
      category: "reminder",
      deepLink: "/automations",
      source: "scheduling",
    });

    expect(notificationGroupKey(approval)).toBe("lifeops");
    expect(notificationGroupLabel(approval)).toBe("Lifeops");
    expect(
      groupDashboardNotifications([approval, reminder, scheduler]).map(
        (group) => ({
          key: group.key,
          ids: group.rows.map((row) => row.id),
        }),
      ),
    ).toEqual([
      { key: "scheduling", ids: [scheduler.id] },
      { key: "lifeops", ids: [reminder.id, approval.id] },
    ]);
  });
});

describe("dampenPull", () => {
  it("has a slop dead zone, halves travel, and clamps", () => {
    expect(dampenPull(0)).toBe(0);
    expect(dampenPull(8)).toBe(0); // inside the dead zone
    expect(dampenPull(48)).toBe(20); // (48-8)/2
    expect(dampenPull(88)).toBe(PULL_COMMIT_PX); // commit travel ≈ 88px raw
    expect(dampenPull(10_000)).toBe(96); // clamped rubber band
  });
});

describe("notificationPullRevealProgress", () => {
  it("tracks pull travel, staggers later groups, and finishes by commit", () => {
    expect(notificationPullRevealProgress(0, 0)).toBe(0);
    expect(notificationPullRevealProgress(PULL_COMMIT_PX / 2, 0)).toBe(0.5);
    expect(notificationPullRevealProgress(PULL_COMMIT_PX / 2, 2)).toBeLessThan(
      0.5,
    );
    expect(notificationPullRevealProgress(PULL_COMMIT_PX, 4)).toBe(1);
  });
});

describe("NotificationsHomeCenter", () => {
  it("renders nothing while the empty inbox is still hydrating", () => {
    const { container } = render(<NotificationsHomeCenter />);
    expect(container.firstChild).toBeNull();
  });

  it("reveals a subtle empty status through the normal pull gesture", () => {
    __setHydratedForTests(true);
    render(<NotificationsHomeCenter />);
    const center = screen.getByTestId("home-notification-center");
    const list = screen.getByTestId("home-notification-list");

    expect(center.className).toContain("min-h-14");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 58,
    });

    const empty = screen.getByTestId("notifications-empty");
    const partialOpacity = Number.parseFloat(empty.style.opacity);
    expect(empty.textContent).toBe("No Notifications");
    expect(partialOpacity).toBeGreaterThan(0);
    expect(partialOpacity).toBeLessThan(1);
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 140,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 140,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("1");

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 2,
      clientX: 10,
      clientY: 140,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });
    expect(
      Number.parseFloat(
        screen.getByTestId("notifications-empty").style.opacity,
      ),
    ).toBeLessThan(1);
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 2,
      clientX: 10,
      clientY: 10,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });

  it("supports the native touch path while the hydrated inbox is empty", () => {
    __setHydratedForTests(true);
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(list, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ clientX: 12, clientY: 150 }],
    });
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("1");
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-empty").textContent).toBe(
      "No Notifications",
    );

    fireEvent.touchStart(list, {
      touches: [{ clientX: 10, clientY: 150 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ clientX: 12, clientY: 10 }],
    });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });

  it("renders the inbox rows once notifications arrive — no unread count badge", () => {
    __ingestNotificationForTests(
      makeNotification({
        title: "Reminder fired",
        category: "reminder",
        source: "scheduling",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "Deploy approved",
        readAt: Date.now(),
        source: "workflow",
      }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    // The header is a bare eyebrow: no numeric unread badge next to the label.
    expect(screen.queryByTestId("notifications-unread-badge")).toBeNull();
    expect(screen.getByText("Reminder fired")).toBeTruthy();
  });

  it("carries no read-state chrome — no unread dot, no data-unread attribute", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Disk almost full" }),
    );
    render(<NotificationsHomeCenter />);
    // Platform-shade model: presence in the list IS the state; rows never
    // restyle on read.
    const row = screen.getByTestId("notification-row");
    expect(row.getAttribute("data-unread")).toBeNull();
    expect(screen.queryByTestId("notification-unread-dot")).toBeNull();
  });

  it("tap follows a safe deep link and clears the row directly", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(__getStateForTests().notifications).toHaveLength(0);
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
  });

  it("tap never navigates an unsafe deep link but still clears the row", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "javascript:alert(1)" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("tap clears only the activated row and leaves its sibling", () => {
    __ingestNotificationForTests(
      makeNotification({
        title: "Keep me",
        category: "system",
        source: "system",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "Dismiss me",
        category: "general",
        source: "agent",
      }),
    );
    render(<NotificationsHomeCenter />);
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(2);
    expect(screen.queryByTestId("notification-row-dismiss")).toBeNull();
    const target = screen.getByText("Dismiss me").closest("li") as HTMLElement;
    fireEvent.click(
      target.querySelector('[data-testid="notification-row"]') as HTMLElement,
    );
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("has no header bulk actions — no mark-all checkmark, no clear-all trash", () => {
    __ingestNotificationForTests(makeNotification());
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    // Rows act one at a time; the shade carries no bulk affordances.
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
  });

  it("the inbox CONTAINER has no chrome — glass lives on the cards", () => {
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    const card = screen.getByTestId("home-notification-center");
    expect(card.className).not.toContain("backdrop-blur");
    expect(card.className).not.toContain("border");
    expect(card.className).not.toMatch(/bg-black|bg-white/);
  });

  it("rows are liquid-glass cards (shared recipe on the swipe surface)", () => {
    __ingestNotificationForTests(makeNotification({ title: "Glass" }));
    render(<NotificationsHomeCenter />);
    const surface = screen.getByTestId("notification-row-swipe");
    expect(surface.className).toContain("eliza-notif-glass");
    expect(surface.className).toContain("rounded-2xl");
    // The recipe itself ships in the component's style block (fill + sheen +
    // inset edge + blur), so the class is the single source of the look.
    const css = document.querySelector("style")?.textContent ?? "";
    expect(css).toContain(".eliza-notif-glass");
    expect(css).toContain("backdrop-filter");
    expect(css).toContain("box-shadow");
  });

  it("acting on a row removes it; surviving rows keep their stable order", () => {
    __ingestNotificationForTests(
      makeNotification({
        title: "Second",
        category: "system",
        source: "system",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "First", source: "agent" }),
    );
    render(<NotificationsHomeCenter />);
    const titles = () =>
      screen
        .getAllByTestId("notification-row")
        .map((el) => el.textContent ?? "");
    expect(titles()[0]).toContain("First");
    fireEvent.click(screen.getAllByTestId("notification-row")[0]);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("Second");
  });

  it("always priority-triages without a sort toggle", () => {
    const urgentOld = makeNotification({
      priority: "urgent",
      title: "Urgent old",
      createdAt: 1_600_000_000_000,
    });
    const highNew = makeNotification({
      priority: "high",
      title: "High new",
      category: "system",
    });
    __ingestNotificationForTests(urgentOld);
    __ingestNotificationForTests(highNew);
    render(<NotificationsHomeCenter />);
    const titles = () =>
      screen
        .getAllByTestId("notification-row")
        .map((el) => el.textContent ?? "");
    // Priority order is fixed: urgent outranks high despite being older.
    expect(titles()[0]).toContain("Urgent old");
    expect(screen.queryByTestId("notifications-sort-priority")).toBeNull();
    expect(screen.queryByTestId("notifications-sort-time")).toBeNull();
  });

  it("renders no headers or dividers — the physical grouping is the structure", () => {
    __ingestNotificationForTests(makeNotification());
    __ingestNotificationForTests(
      makeNotification({ category: "reminder", title: "Water the plants" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.queryByText("Notifications")).toBeNull();
    // The producer-group eyebrow headers (and their counts) are gone: groups are
    // separated by spacing only.
    expect(screen.queryByTestId("notification-group-label")).toBeNull();
    expect(screen.queryByTestId("notification-stack-count")).toBeNull();
  });

  it("caps rendering at 100 rows when the shade + stack are expanded", () => {
    for (let i = 0; i < 120; i++) {
      __ingestNotificationForTests(makeNotification({ priority: "high" }));
    }
    render(<NotificationsHomeCenter />);
    expandShade();
    expect(screen.getByTestId("notification-source-count").textContent).toBe(
      "99+",
    );
    // Stacks persist through the shade change; fan the group via a peek tap.
    fireEvent.click(screen.getAllByTestId("notification-stack-peek")[0]);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(100);
  });

  it("renders rows with no accent rail at any priority (lock-screen restraint)", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", title: "Quiet one" }),
    );
    render(<NotificationsHomeCenter />);
    expandShade();
    fireEvent.click(screen.getAllByTestId("notification-stack-peek")[0]);
    // A notification is its glass card - no leading edge highlight even for
    // urgent rows, no per-row icon chip.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.queryByTestId("notification-row-accent")).toBeNull();
    expect(screen.queryByTestId("notification-row-icon")).toBeNull();
  });

  it("never renders a count chip — the title line is title + time only", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "3 new files", data: { count: 3 } }),
    );
    render(<NotificationsHomeCenter />);
    // Coalesced arrivals speak through their title/body; no bare number rides
    // the notification header.
    expect(screen.queryByTestId("notification-count-chip")).toBeNull();
  });
});

// ── Z-stacked groups (rested shade) ─────────────────────────────────────────
describe("NotificationsHomeCenter (Z-stacked groups)", () => {
  it("a multi-row group renders as a stack: top card + glass peeks in Z", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Oldest", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Middle", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Top urgent", priority: "urgent" }),
    );
    render(<NotificationsHomeCenter />);
    // One interactive card — the group's highest-priority row.
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Top urgent");
    // The rest of the group peeks from beneath as pure glass depth cues.
    const stack = screen.getByTestId("notification-stack");
    expect(stack).toBeTruthy();
    const peeks = screen.getAllByTestId("notification-stack-peek");
    expect(peeks).toHaveLength(2);
    for (const peek of peeks) {
      expect(peek.className).toContain("eliza-notif-glass");
      // Peeks are TAPPABLE (tap fans the stack) and remain crisp.
      expect(peek.tagName).toBe("BUTTON");
      expect(peek.style.filter).toBe("");
      expect(peek.style.bottom).toBe("18px");
    }
    // Deeper cards sit lower in Z and protrude further.
    expect(Number(peeks[0].style.zIndex)).toBeGreaterThan(
      Number(peeks[1].style.zIndex),
    );
    expect(peeks[0].style.opacity).toBe("0.88");
    expect(peeks[1].style.opacity).toBe("0.72");
    expect(peeks[0].style.transform).toBe("translateY(5px) scale(0.975)");
    expect(peeks[1].style.transform).toBe("translateY(10px) scale(0.95)");
    expect(stack.style.paddingBottom).toBe("18px");
    // The producer tile is vertically centered and carries the stack total.
    const sourceIcon = screen.getByTestId("notification-source-icon");
    expect(sourceIcon.className).toContain("h-10");
    expect(sourceIcon.className).toContain("w-10");
    expect(sourceIcon.className).toContain("items-center");
    const count = screen.getByTestId("notification-source-count");
    expect(count.textContent).toBe("3");
    expect(count.className).toContain("min-w-5");
    expect(count.className).toContain("tabular-nums");
  });

  it("stacks cap their visual depth at two peeks", () => {
    for (let i = 0; i < 5; i++) {
      __ingestNotificationForTests(makeNotification({ priority: "high" }));
    }
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("a single-row group renders flat — no stack, no peeks", () => {
    __ingestNotificationForTests(makeNotification({ title: "Solo" }));
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
  });

  it("tapping the collapsed top card fans the stack instead of opening its deep link", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", deepLink: "/settings" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", deepLink: "/settings" }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "C",
        priority: "urgent",
        deepLink: "/settings",
      }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications).toHaveLength(3);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
  });

  it("expanding the shade keeps the stacks; tapping a peek fans the group in place", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    // Pulling the shade open reveals more groups but never flattens a stack.
    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    // Tapping the peeked card below the top one fans the stack out.
    fireEvent.click(screen.getAllByTestId("notification-stack-peek")[0]);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
    // Priority order inside the fanned group: urgent first.
    const titles = screen
      .getAllByTestId("notification-row")
      .map((el) => el.textContent ?? "");
    expect(titles[0]).toContain("C");
    // Expanded producer controls are local to the stack.
    expect(screen.getByTestId("notification-stack-collapse").textContent).toBe(
      "Show Less",
    );
    expect(screen.getByTestId("notification-stack-clear").textContent).toBe("");
    expect(screen.getByTestId("notifications-count").textContent).toBe(
      "3 Notifications",
    );
    fireEvent.click(screen.getByTestId("notification-stack-collapse"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    expect(screen.queryByTestId("notification-stack-collapse")).toBeNull();
  });

  it("fanning a stack enters the expanded shade", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getAllByTestId("notification-stack-peek")[0]);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    const list = screen.getByTestId("home-notification-list");
    expect(list.className).toContain("touch-pan-y");
    expect(list.className).toContain("overflow-x-hidden");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
  });

  it("requires X then Clear before removing only that producer stack", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", source: "github" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", source: "github" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Keep", source: "calendar" }),
    );
    render(<NotificationsHomeCenter />);
    const stack = screen.getByTestId("notification-stack");
    fireEvent.click(
      stack.querySelector('[data-testid="notification-row"]') as HTMLElement,
    );
    const clear = screen.getByTestId("notification-stack-clear");
    expect(clear.textContent).toBe("");
    fireEvent.click(clear);
    expect(clear.textContent).toBe("Clear");
    expect(__getStateForTests().notifications).toHaveLength(3);
    fireEvent.click(clear);
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(screen.getByText("Keep")).toBeTruthy();
  });

  it("a drag that starts ON a stack still pulls the shade open and never fans the stack", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    __ingestNotificationForTests(
      // Its own producer group, so the expanded shade shows it flat.
      makeNotification({
        title: "Quiet",
        priority: "normal",
        category: "system",
        source: "system",
      }),
    );
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    const stack = screen.getByTestId("notification-stack");
    // The stack has no drag handling of its own — the pointer events bubble to
    // the list, whose directional pull expands the shade; the stack stays a
    // stack (fanning is tap-only via the peeked cards).
    fireEvent.pointerDown(stack, {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      pointerId: 8,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      pointerId: 8,
      clientX: 12,
      clientY: 140,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      button: 0,
      isPrimary: true,
      pointerId: 8,
      clientX: 12,
      clientY: 140,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Still stacked: the pull revealed the sub-interrupt row, not the stack.
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("SWIPE-dismissing the stack top promotes the next card WITHOUT its fling-out state (keyed remount)", () => {
    // The single-child stacked top card must be keyed by id: on swipe-dismiss
    // the promoted card would otherwise reconcile into the outgoing card's slot
    // and inherit its `dismissing` transform (translateX 120%) — painting the
    // arriving card invisible/off-screen.
    vi.useFakeTimers();
    try {
      __ingestNotificationForTests(
        makeNotification({ title: "Below", priority: "high" }),
      );
      __ingestNotificationForTests(
        makeNotification({ title: "On top", priority: "urgent" }),
      );
      render(<NotificationsHomeCenter />);
      const swipe = screen.getByTestId("notification-row-swipe");
      // Drag the top card right past SWIPE_DISMISS_PX (88) and release → the
      // outgoing card gets `translateX(120%)`, then the store removes it (180ms).
      const step = (type: string, x: number) =>
        (
          fireEvent as unknown as Record<
            string,
            (e: Element, i: unknown) => void
          >
        )[type](swipe, {
          clientX: x,
          clientY: 22,
          pointerId: 3,
          pointerType: "touch",
        });
      step("pointerDown", 20);
      step("pointerMove", 80);
      step("pointerMove", 150);
      step("pointerUp", 150);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      // The promoted "Below" card is fully visible: no residual fling-out
      // transform, full opacity — the key forced a fresh mount.
      const promoted = screen.getByTestId("notification-row-swipe");
      expect(screen.getByTestId("notification-row").textContent).toContain(
        "Below",
      );
      expect(promoted.style.transform).toBeFalsy();
      expect(
        promoted.style.opacity === "" || promoted.style.opacity === "1",
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Pull-gesture expand/collapse (no more/less buttons) ─────────────────────
describe("NotificationsHomeCenter (pull to expand / collapse)", () => {
  function seedTriage(): void {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent thing" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", title: "Normal thing" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "low", title: "Low thing" }),
    );
  }

  it("fades the passive total out while expanded and back in when collapsed", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    const count = screen.getByTestId("notifications-count");
    expect(count.textContent).toBe("3 Notifications");
    expect(count.closest("button")).toBeNull();
    expect(count.style.opacity).toBe("1");
    expect(count.getAttribute("aria-hidden")).toBeNull();
    const chevron = screen.getByTestId("notifications-count-chevron");
    expect(chevron.classList.contains("h-3")).toBe(true);
    expect(chevron.classList.contains("w-3")).toBe(true);
    expect(screen.queryByTestId("notifications-expand-toggle")).toBeNull();
    expect(screen.queryByText(/more|show less/i)).toBeNull();
    expandShade();
    expect(count.textContent).toBe("3 Notifications");
    expect(count.style.opacity).toBe("0");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    collapseShade();
    expect(count.style.opacity).toBe("1");
    expect(count.getAttribute("aria-hidden")).toBeNull();
  });

  it("gestures expand to all priorities and compress back", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // All three priorities are now represented — still stacked (1 top card +
    // 2 tappable peeks); the shade change reveals groups, never flattens them.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    collapseShade();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.queryAllByTestId("notification-stack-peek")).toHaveLength(0);
  });

  it("requires X then Clear before clearing the expanded inbox", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    expandShade();
    const clear = screen.getByTestId("notifications-clear-all");
    expect(clear.className).toContain("h-8");
    expect(clear.className).not.toContain("min-h-touch");
    expect(clear.textContent).toBe("");
    fireEvent.click(clear);
    expect(clear.textContent).toBe("Clear");
    expect(__getStateForTests().notifications).toHaveLength(3);
    fireEvent.click(clear);
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("a mouse pull-down past the commit travel expands the shade", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 9,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 9,
      clientX: 12,
      clientY: 140,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 9,
      clientX: 12,
      clientY: 140,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.style.transition).toContain("320ms");
    // Stacks persist through the pull; the peeks carry the revealed rows.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("reveals hidden notification groups continuously before release", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        title: "Normal thing",
        category: "system",
        source: "system",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        title: "Low thing",
        category: "general",
        source: "agent",
      }),
    );
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(0);

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 10,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 10,
      clientX: 10,
      clientY: 58,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    const countOpacity = Number.parseFloat(
      screen.getByTestId("notifications-count").style.opacity,
    );
    expect(countOpacity).toBeGreaterThan(0);
    expect(countOpacity).toBeLessThan(1);
    const clear = screen.getByTestId("notifications-clear-all");
    const clearReveal = clear.closest("li") as HTMLElement;
    expect(Number.parseFloat(clearReveal.style.opacity)).toBeGreaterThan(0);
    expect(Number.parseFloat(clearReveal.style.opacity)).toBeLessThan(1);
    const revealedGroups = list.querySelectorAll(
      ":scope > [data-notification-pull-reveal]",
    );
    expect(revealedGroups).toHaveLength(2);
    for (const group of revealedGroups) {
      const opacity = Number.parseFloat((group as HTMLElement).style.opacity);
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
    }
  });

  it("a short pull springs back without toggling", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 9,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 9,
      clientX: 10,
      clientY: 40, // 30px raw → dampened 11px < commit
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 9,
      clientX: 10,
      clientY: 40,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
  });

  it("a touch pull-down expands the shade (native non-passive listener path)", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.touchStart(list, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ clientX: 12, clientY: 150 }],
    });
    fireEvent.touchEnd(list, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Stacks persist through the pull; the peeks carry the revealed rows.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("a continuous drag that scrolls the expanded list back to the top does NOT collapse (re-base at the crossing)", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // The list is scrolled down 150px; the browser owns the pan until scrollTop
    // hits 0. A naive dy-from-touchstart would arrive at the top already maxed
    // and collapse; the re-based pull measures only the AT-TOP travel.
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      writable: true,
      value: 150,
    });
    fireEvent.touchStart(list, { touches: [{ clientX: 10, clientY: 10 }] });
    // Still scrolled → not a pull.
    fireEvent.touchMove(list, { touches: [{ clientX: 10, clientY: 100 }] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Reaches the top; the anchor rebases here, so the remaining travel is tiny.
    (list as unknown as { scrollTop: number }).scrollTop = 0;
    fireEvent.touchMove(list, { touches: [{ clientX: 12, clientY: 210 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 12, clientY: 232 }] });
    fireEvent.touchEnd(list, { touches: [] });
    // Only ~22px of at-top travel → below commit → shade stays expanded.
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("trackpad fingers-down (wheel deltaY < 0) at the top expands the rested shade", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("the wheel gesture is DIRECTIONAL: trailing same-direction momentum never collapses what it just expanded", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // The macOS momentum tail: the same flick keeps emitting deltaY < 0 events
    // after the commit. The old toggle re-fired on these and snapped the shade
    // shut ("expands but only for a second"); the directional gesture treats
    // expand-direction input while expanded as a no-op.
    for (let i = 0; i < 8; i++) {
      fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    }
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("trackpad fingers-up (wheel deltaY > 0) at the top collapses the expanded shade", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Fingers-down (deltaY < 0) while already expanded must NOT collapse —
    // that direction only expands.
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Fingers-up at the top (jsdom list has no scroll overflow) collapses.
    // Collapse contributions are per-event capped so a single scroll flick on
    // an overflowing list can never commit — it takes a sustained gesture.
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
  });

  it("a mouse drag UP collapses the expanded shade; drag down while expanded is a no-op", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Drag DOWN while expanded: the expand direction in a state with nothing
    // left to expand — springs back, never collapses.
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 4,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 4,
      clientX: 10,
      clientY: 150,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 4,
      clientX: 10,
      clientY: 150,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // Drag UP past the commit travel collapses.
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 5,
      clientX: 10,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 5,
      clientX: 12,
      clientY: 20,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 5,
      clientX: 12,
      clientY: 20,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("a touch drag UP collapses the expanded shade when the list has no scroll overflow", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // jsdom geometry: scrollHeight == clientHeight == 0 → no overflow, so the
    // pan-y scroller has nothing to do and the shade owns the upward drag.
    fireEvent.touchStart(list, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 12, clientY: 60 }] });
    fireEvent.touchEnd(list, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("a bottom-edge touch drag stays scroll-owned while the expanded shade overflows", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    setOverflowingListGeometry(list);

    fireEvent.touchStart(list, { touches: [{ clientX: 150, clientY: 470 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 152, clientY: 330 }] });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.style.transform).toBe("");
  });

  it("an upward touch in the middle of overflowing content scrolls instead of collapsing", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    setOverflowingListGeometry(list);

    fireEvent.touchStart(list, { touches: [{ clientX: 150, clientY: 250 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 152, clientY: 90 }] });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("rebases an upward close when an overflowing touch reaches the list end", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    setOverflowingListGeometry(list);

    fireEvent.touchStart(list, { touches: [{ clientX: 150, clientY: 250 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 150, clientY: 150 }] });
    (list as unknown as { scrollTop: number }).scrollTop = 600;
    fireEvent.touchMove(list, { touches: [{ clientX: 150, clientY: 100 }] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    fireEvent.touchMove(list, { touches: [{ clientX: 150, clientY: -40 }] });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("a touch drag DOWN while expanded never collapses (directional, not a toggle)", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    fireEvent.touchStart(list, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 12, clientY: 150 }] });
    fireEvent.touchEnd(list, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("the pull is inert while the list is scrolled away from the top", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      value: 60,
      writable: true,
    });
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 3,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 3,
      clientX: 10,
      clientY: 160,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 3,
      clientX: 10,
      clientY: 160,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("with nothing hidden the rested shade only shows its passive total", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Only one" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notifications-pull-hint")).toBeNull();
    expect(screen.queryByTestId("notifications-expand-toggle")).toBeNull();
    expect(screen.getByTestId("notifications-count").textContent).toBe(
      "1 Notification",
    );
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });
});

// ── Touch interaction: the row's OWN pointer handlers (device r8) ──────────
// #15080 moved the inbox inline BELOW the chat glass; "interacting is cooked"
// on device. These tests drive the row's real pointer sequence (not just a
// synthetic click) so tap-to-open and swipe-to-dismiss fire their handlers, and
// pin the exemption markers that keep the ContinuousChatOverlay outside-tap
// collapse-swallower off the notification surface.
describe("NotificationsHomeCenter (touch interaction, device r8)", () => {
  function pointer(
    el: Element,
    type: string,
    {
      x = 0,
      y = 0,
      pointerId = 1,
    }: { x?: number; y?: number; pointerId?: number } = {},
  ): void {
    // jsdom has no PointerEvent ctor; fireEvent.pointerX carries clientX/Y +
    // pointerId + pointerType onto the synthetic event the row handlers read.
    (fireEvent as unknown as Record<string, (e: Element, i: unknown) => void>)[
      type
    ](el, {
      clientX: x,
      clientY: y,
      pointerId,
      pointerType: "touch",
      button: 0,
    });
  }

  it("tap (pointerdown → pointerup, no move) opens directly on touch", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Tap me" }),
    );
    render(<NotificationsHomeCenter />);
    const swipe = screen.getByTestId("notification-row-swipe");
    const button = screen.getByTestId("notification-row");
    // A real touch tap: down then up on the swipe surface, no movement, then the
    // button's synthetic click. suppressClick must not be set.
    pointer(swipe, "pointerDown", { x: 10, y: 10 });
    pointer(swipe, "pointerUp", { x: 10, y: 10 });
    fireEvent.click(button);
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(__getStateForTests().notifications).toHaveLength(0);
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
  });

  it("horizontal swipe past the threshold dismisses the row (and swallows the click)", () => {
    __ingestNotificationForTests(
      makeNotification({
        title: "Keep",
        category: "system",
        source: "system",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "Swipe away",
        category: "general",
        source: "agent",
      }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    const li = screen.getByText("Swipe away").closest("li") as HTMLElement;
    const swipe = li.querySelector(
      '[data-testid="notification-row-swipe"]',
    ) as HTMLElement;
    const button = li.querySelector(
      '[data-testid="notification-row"]',
    ) as HTMLElement;
    // Drag left well past SWIPE_DISMISS_PX (88): down at 120, move to 10 (dx=-110
    // → axis locks x, past threshold), release → commitDismiss(left).
    pointer(swipe, "pointerDown", { x: 120, y: 20 });
    pointer(swipe, "pointerMove", { x: 60, y: 22 });
    pointer(swipe, "pointerMove", { x: 10, y: 22 });
    pointer(swipe, "pointerUp", { x: 10, y: 22 });
    // The synthetic click a swipe emits must be swallowed (suppressClick) so the
    // gesture doesn't ALSO open the row.
    fireEvent.click(button);
    expect(navigateDeepLink).not.toHaveBeenCalled();
    // The row is on its way out (dismissing transform applied); the store
    // removal fires on the 180ms timer. Assert the swipe surface committed.
    expect(swipe.style.transform).toContain("translateX(-120%)");
  });

  it("holding a row does not reveal a hidden action menu", () => {
    vi.useFakeTimers();
    try {
      __ingestNotificationForTests(
        makeNotification({ title: "Hold me", deepLink: "/x" }),
      );
      render(<NotificationsHomeCenter />);
      const swipe = screen.getByTestId("notification-row-swipe");
      pointer(swipe, "pointerDown", { x: 10, y: 10 });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.queryByTestId("notification-row-options")).toBeNull();
      expect(navigateDeepLink).not.toHaveBeenCalled();
      expect(__getStateForTests().notifications).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a vertical drag on a row never doubles as an open", () => {
    __ingestNotificationForTests(makeNotification({ title: "Draggy" }));
    render(<NotificationsHomeCenter />);
    const swipe = screen.getByTestId("notification-row-swipe");
    const button = screen.getByTestId("notification-row");
    pointer(swipe, "pointerDown", { x: 10, y: 10 });
    pointer(swipe, "pointerMove", { x: 12, y: 60 }); // axis locks y
    pointer(swipe, "pointerUp", { x: 12, y: 60 });
    fireEvent.click(button); // the synthetic click the drag emits
    // The drag belonged to the scroller/pull, so the row remains untouched.
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("marks the row + its center with the overlay-exemption hooks the collapse-swallower reads", () => {
    __ingestNotificationForTests(makeNotification({ title: "Exempt" }));
    render(<NotificationsHomeCenter />);
    // The ContinuousChatOverlay outside-tap collapse-swallower exempts anything
    // under [data-testid="home-notification-center"] or [data-notif-row]; both
    // must be present or a row tap gets eaten (the r8 "cooked" bug).
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    const row = screen.getByText("Exempt").closest("li") as HTMLElement;
    expect(row.hasAttribute("data-notif-row")).toBe(true);
  });
});
