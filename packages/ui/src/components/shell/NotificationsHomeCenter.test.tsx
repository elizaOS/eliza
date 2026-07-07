// @vitest-environment jsdom

// Dashboard notification center behavior against the real notification store
// (driven via the test-only ingest; HTTP mutations mocked at the API client).
// Pins the shade spec: priority-only triage, liquid-glass Z-stacked groups,
// pull-gesture expand/collapse (no more/less buttons), single-open chromeless
// option strips, and swipe-to-dismiss.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Haptics is a native bridge; stub it so the row's long-press path
// (`void haptics.light()`) doesn't leave a real pending promise under fake
// timers in the touch-interaction tests.
vi.mock("../../bridge/capacitor-bridge", () => ({
  haptics: { light: vi.fn(async () => {}), medium: vi.fn(async () => {}) },
}));

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
} from "../../state/notifications/notification-store";
import {
  dampenPull,
  NotificationsHomeCenter,
  notificationRowOptions,
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

describe("dampenPull", () => {
  it("has a slop dead zone, halves travel, and clamps", () => {
    expect(dampenPull(0)).toBe(0);
    expect(dampenPull(8)).toBe(0); // inside the dead zone
    expect(dampenPull(48)).toBe(20); // (48-8)/2
    expect(dampenPull(88)).toBe(PULL_COMMIT_PX); // commit travel ≈ 88px raw
    expect(dampenPull(10_000)).toBe(96); // clamped rubber band
  });
});

describe("notificationRowOptions", () => {
  it("every notification exposes at least one action plus Dismiss", () => {
    const plain = makeNotification({ deepLink: undefined });
    const ids = notificationRowOptions(plain).map((o) => o.id);
    expect(ids).toEqual(["dismiss"]);
    const linked = makeNotification({ deepLink: "/settings" });
    expect(notificationRowOptions(linked).map((o) => o.id)).toEqual([
      "open",
      "dismiss",
    ]);
  });

  it("a message offers Suggest a reply as a chat prefill", () => {
    const msg = makeNotification({
      category: "message",
      title: "New message from Alice",
      body: "design doc?",
      deepLink: "/chat",
    });
    const opts = notificationRowOptions(msg);
    const suggest = opts.find((o) => o.id === "suggest-reply");
    expect(suggest?.kind).toBe("prefill");
    expect(suggest?.prefill).toContain("New message from Alice");
    expect(opts.map((o) => o.id)).toEqual(["suggest-reply", "open", "dismiss"]);
  });

  it("labels the open action by category (Review / Open task / View run)", () => {
    const label = (category: AgentNotification["category"]) =>
      notificationRowOptions(
        makeNotification({ category, deepLink: "/x" }),
      ).find((o) => o.id === "open")?.label;
    expect(label("approval")).toBe("Review");
    expect(label("task")).toBe("Open task");
    expect(label("workflow")).toBe("View run");
    expect(label("reminder")).toBe("Open");
  });

  it("an unsafe deepLink yields no open option", () => {
    const n = makeNotification({ deepLink: "javascript:alert(1)" });
    expect(
      notificationRowOptions(n).find((o) => o.id === "open"),
    ).toBeUndefined();
  });
});

describe("NotificationsHomeCenter", () => {
  it("renders nothing while the inbox is empty", () => {
    const { container } = render(<NotificationsHomeCenter />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the inbox rows once notifications arrive — no unread count badge", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Reminder fired", category: "reminder" }),
    );
    __ingestNotificationForTests(
      makeNotification({
        title: "Deploy approved",
        readAt: Date.now(),
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

  it("tap expands contextual options; Open follows the deep link and clears the row", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Open settings" }),
    );
    render(<NotificationsHomeCenter />);
    const row = screen.getByTestId("notification-row");
    // First tap: expand, don't navigate.
    fireEvent.click(row);
    expect(navigateDeepLink).not.toHaveBeenCalled();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("notification-option-open"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    // Shade acknowledgement: acting on a notification removes it.
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("tap again collapses the options without acting", () => {
    __ingestNotificationForTests(makeNotification({ deepLink: "/settings" }));
    render(<NotificationsHomeCenter />);
    const row = screen.getByTestId("notification-row");
    fireEvent.click(row);
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
    expect(__getStateForTests().notifications).toHaveLength(1);
  });

  it("expanding one row collapses the other — the option strip is single-open", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "First", category: "system" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Second", category: "general" }),
    );
    render(<NotificationsHomeCenter />);
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    // Pressing the second notification collapses the first — exactly one
    // option strip is ever open.
    fireEvent.click(rows[1]);
    expect(rows[0].getAttribute("aria-expanded")).toBe("false");
    expect(rows[1].getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("notification-row-options")).toHaveLength(1);
  });

  it("an unsafe deep link exposes no Open option; Dismiss still clears", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "javascript:alert(1)" }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(screen.queryByTestId("notification-option-open")).toBeNull();
    fireEvent.click(screen.getByTestId("notification-option-dismiss"));
    expect(navigateDeepLink).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("a message row's Suggest a reply prefills the chat and clears the row", () => {
    __ingestNotificationForTests(
      makeNotification({
        category: "message",
        title: "New message from Alice",
        deepLink: "/chat",
      }),
    );
    render(<NotificationsHomeCenter />);
    const prefillEvents: string[] = [];
    const onPrefill = (e: Event) =>
      prefillEvents.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener("eliza:chat:prefill", onPrefill);
    try {
      fireEvent.click(screen.getByTestId("notification-row"));
      fireEvent.click(screen.getByTestId("notification-option-suggest-reply"));
    } finally {
      window.removeEventListener("eliza:chat:prefill", onPrefill);
    }
    expect(prefillEvents[0]).toContain("New message from Alice");
    expect(__getStateForTests().notifications).toHaveLength(0);
  });

  it("dismisses a single row via its expanded Dismiss option (no corner X)", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Keep me", category: "system" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Dismiss me", category: "general" }),
    );
    render(<NotificationsHomeCenter />);
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(2);
    // The hover-X is gone entirely.
    expect(screen.queryByTestId("notification-row-dismiss")).toBeNull();
    const target = screen.getByText("Dismiss me").closest("li") as HTMLElement;
    fireEvent.click(
      target.querySelector('[data-testid="notification-row"]') as HTMLElement,
    );
    fireEvent.click(
      target.querySelector(
        '[data-testid="notification-option-dismiss"]',
      ) as HTMLElement,
    );
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("has no header bulk actions — no mark-all checkmark, no clear-all trash", () => {
    __ingestNotificationForTests(makeNotification());
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    // Rows manage their own state one at a time (tap to expand, swipe / option
    // to dismiss); the shade carries no bulk affordances at all.
    expect(screen.queryByTestId("notifications-clear-all")).toBeNull();
    expect(screen.queryByTestId("notifications-mark-all-read")).toBeNull();
  });

  it("right-click expands the same contextual options (no floating menu)", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Menu me", deepLink: "/x" }),
    );
    render(<NotificationsHomeCenter />);
    const li = screen.getByText("Menu me").closest("li") as HTMLElement;
    fireEvent.contextMenu(li);
    expect(screen.queryByTestId("notification-row-menu")).toBeNull();
    expect(screen.getByTestId("notification-row-options")).toBeTruthy();
    fireEvent.click(screen.getByTestId("notification-option-dismiss"));
    expect(screen.queryByText("Menu me")).toBeNull();
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

  it("expanded options are bare action text — no fill, no border, no pill", () => {
    __ingestNotificationForTests(
      makeNotification({
        category: "message",
        title: "M",
        deepLink: "/chat",
      }),
    );
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notification-row"));
    const strip = screen.getByTestId("notification-row-options");
    const buttons = Array.from(strip.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) {
      expect(b.className).not.toMatch(/\bbg-/);
      expect(b.className).not.toMatch(/rounded-full/);
      expect(b.className).not.toMatch(/\bborder\b/);
      // The label is the affordance: text styling only.
      expect(b.className).toMatch(/text-white/);
    }
  });

  it("acting on a row removes it; surviving rows keep their stable order", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Second", category: "system" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "First" }),
    );
    render(<NotificationsHomeCenter />);
    const titles = () =>
      screen
        .getAllByTestId("notification-row")
        .map((el) => el.textContent ?? "");
    expect(titles()[0]).toContain("First");
    fireEvent.click(screen.getAllByTestId("notification-row")[0]);
    fireEvent.click(screen.getByTestId("notification-option-dismiss"));
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

  it("has no Notifications header — view-group eyebrows carry the structure", () => {
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    expect(screen.queryByText("Notifications")).toBeNull();
    expect(
      screen.getAllByTestId("notification-group-label").length,
    ).toBeGreaterThan(0);
  });

  it("caps rendering at 100 rows when the shade is expanded", () => {
    for (let i = 0; i < 120; i++) {
      __ingestNotificationForTests(makeNotification({ priority: "high" }));
    }
    render(<NotificationsHomeCenter />);
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
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
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    // A notification is its glass card - no leading edge highlight even for
    // urgent rows, no per-row icon chip.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.queryByTestId("notification-row-accent")).toBeNull();
    expect(screen.queryByTestId("notification-row-icon")).toBeNull();
  });

  it("renders a count chip when data.count > 1 (§C.3 coalescing)", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "3 new files", data: { count: 3 } }),
    );
    render(<NotificationsHomeCenter />);
    const chip = screen.getByTestId("notification-count-chip");
    // The visible glyph is the count; a visually-hidden suffix names it for AT.
    expect(chip.textContent).toContain("3");
    expect(chip.querySelector(".sr-only")?.textContent).toContain("grouped");
  });

  it("omits the count chip for a single (count ≤ 1 or absent) notification", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "one", data: { count: 1 } }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "plain", category: "system" }),
    );
    render(<NotificationsHomeCenter />);
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
      expect(peek.getAttribute("aria-hidden")).toBe("true");
      expect(peek.style.transform).toMatch(/translateY\(\d+px\) scale\(0\.9/);
    }
    // Deeper cards sit lower in Z and protrude further.
    expect(Number(peeks[0].style.zIndex)).toBeGreaterThan(
      Number(peeks[1].style.zIndex),
    );
    expect(peeks[0].style.transform).toContain("translateY(8px)");
    expect(peeks[1].style.transform).toContain("translateY(16px)");
    // The eyebrow names the stack size.
    expect(screen.getByTestId("notification-stack-count").textContent).toBe(
      "3",
    );
  });

  it("stacks cap their visual depth at two peeks", () => {
    for (let i = 0; i < 5; i++) {
      __ingestNotificationForTests(makeNotification({ priority: "high" }));
    }
    render(<NotificationsHomeCenter />);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByTestId("notification-stack-count").textContent).toBe(
      "5",
    );
  });

  it("a single-row group renders flat — no stack, no peeks", () => {
    __ingestNotificationForTests(makeNotification({ title: "Solo" }));
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
  });

  it("expanding the shade fans every stack out flat", () => {
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
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
    // Priority order inside the fanned group: urgent first.
    const titles = screen
      .getAllByTestId("notification-row")
      .map((el) => el.textContent ?? "");
    expect(titles[0]).toContain("C");
  });

  it("swiping away the top card surfaces the next card in the stack", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Below", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "On top", priority: "urgent" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.getByTestId("notification-row").textContent).toContain(
      "On top",
    );
    fireEvent.click(screen.getByTestId("notification-row"));
    fireEvent.click(screen.getByTestId("notification-option-dismiss"));
    // The store removed the top row; the group's next card takes the top.
    expect(screen.getByTestId("notification-row").textContent).toContain(
      "Below",
    );
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
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

  it("has NO more/less buttons — a passive hint and an sr-only toggle instead", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    // The buttons are gone (regression for the removed affordance).
    expect(screen.queryByTestId("notifications-show-all")).toBeNull();
    expect(screen.queryByTestId("notifications-show-less")).toBeNull();
    // Rested: only the interrupt-tier row renders; a quiet non-interactive
    // hint names the hidden count.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    const hint = screen.getByTestId("notifications-pull-hint");
    expect(hint.textContent).toContain("2 more");
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    expect(hint.className).toContain("pointer-events-none");
    // Keyboard/AT path: visually hidden, still a real button.
    const toggle = screen.getByTestId("notifications-expand-toggle");
    expect(toggle.className).toContain("sr-only");
    expect(toggle.textContent).toContain("2 more");
  });

  it("the sr-only toggle expands to all priorities and compresses back", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
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
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
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
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
  });

  it("wheel-up at the top of the rested shade expands it", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("scrolling back up past the top compresses the expanded shade", () => {
    seedTriage();
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // At the top (jsdom scrollTop = 0), continuing to scroll up overscrolls →
    // the shade compresses back to triage.
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
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

  it("with nothing hidden the rested shade has no hint, no toggle, no pull", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Only one" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notifications-pull-hint")).toBeNull();
    expect(screen.queryByTestId("notifications-expand-toggle")).toBeNull();
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

  it("tap (pointerdown → pointerup, no move) expands the row's options on TOUCH", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "/settings", title: "Tap me" }),
    );
    render(<NotificationsHomeCenter />);
    const swipe = screen.getByTestId("notification-row-swipe");
    const button = screen.getByTestId("notification-row");
    // A real touch tap: down then up on the swipe surface, no movement, then the
    // button's synthetic click. suppressClick must NOT be set (no swipe / long
    // press), so the tap expands the row.
    pointer(swipe, "pointerDown", { x: 10, y: 10 });
    pointer(swipe, "pointerUp", { x: 10, y: 10 });
    fireEvent.click(button);
    expect(screen.getByTestId("notification-row-options")).toBeTruthy();
    expect(navigateDeepLink).not.toHaveBeenCalled();
  });

  it("horizontal swipe past the threshold dismisses the row (and swallows the click)", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "Keep", category: "system" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "Swipe away", category: "general" }),
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

  it("a long-press expands the row's options on TOUCH", () => {
    vi.useFakeTimers();
    try {
      __ingestNotificationForTests(
        makeNotification({ title: "Hold me", deepLink: "/x" }),
      );
      render(<NotificationsHomeCenter />);
      const swipe = screen.getByTestId("notification-row-swipe");
      pointer(swipe, "pointerDown", { x: 10, y: 10 });
      // Hold past LONG_PRESS_MS (420) with no movement → options expand. Wrap
      // the timer flush in act() so the parent's single-open state commits
      // before the query reads the DOM.
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByTestId("notification-row-options")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a vertical drag on a row never doubles as a tap (pull, not expand)", () => {
    __ingestNotificationForTests(makeNotification({ title: "Draggy" }));
    render(<NotificationsHomeCenter />);
    const swipe = screen.getByTestId("notification-row-swipe");
    const button = screen.getByTestId("notification-row");
    pointer(swipe, "pointerDown", { x: 10, y: 10 });
    pointer(swipe, "pointerMove", { x: 12, y: 60 }); // axis locks y
    pointer(swipe, "pointerUp", { x: 12, y: 60 });
    fireEvent.click(button); // the synthetic click the drag emits
    // The drag belonged to the scroller/pull — the options must NOT open.
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
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
