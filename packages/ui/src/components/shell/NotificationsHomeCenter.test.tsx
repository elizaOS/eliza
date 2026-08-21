/**
 * Exercises notification ordering, store-backed dashboard behavior, and
 * auth/base-URL-gated hydration through the jsdom harness. The notification
 * store stays real while API transport and navigation boundaries are mocked.
 */
// @vitest-environment jsdom

// Pins the shade spec: a control-free full inbox, liquid-glass Z-stacked groups
// with no headers/dividers, DIRECTIONAL pull/wheel expand-collapse (down
// expands, up collapses — never a toggle, so trailing trackpad momentum can't
// snap the shade back shut), direct-tap activation, and swipe-to-dismiss.

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
    // notificationProbesEnabled reads the configured base URL before every
    // hydration request; empty string = same-origin (probes enabled).
    getBaseUrl: vi.fn(() => ""),
    markNotificationRead: vi.fn(async () => ({})),
    markAllNotificationsRead: vi.fn(async () => ({})),
    removeNotification: vi.fn(async () => ({})),
    clearNotifications: vi.fn(async () => ({})),
  },
}));

const navigateDeepLink = vi.hoisted(() => vi.fn());

/** Typed authenticated owner fixture for the auth-gated hydration probes. */
const AUTHENTICATED_OWNER: AuthStatusState = {
  phase: "authenticated",
  identity: { id: "u-1", displayName: "Owner", kind: "owner" },
  session: { id: "s-1", kind: "browser", expiresAt: null },
  access: {
    mode: "session",
    passwordConfigured: true,
    ownerConfigured: true,
    role: "OWNER",
  },
};
vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink,
}));

import type { AgentNotification } from "@elizaos/core";
import { client } from "../../api/client";
import {
  __resetAuthStatusForTests,
  __setAuthStatusForTests,
  type AuthStatusState,
} from "../../hooks/useAuthStatus";
import {
  __getStateForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
  __setHydrationFailureForTests,
} from "../../state/notifications/notification-store";
import {
  dampenPull,
  groupDashboardNotifications,
  isInterruptPriority,
  NotificationsHomeCenter,
  notificationGroupKey,
  notificationGroupLabel,
  notificationPullRevealProgress,
  notificationScrollFadeEdges,
  orderDashboardNotifications,
  PULL_COMMIT_PX,
  STACK_FOLD_SETTLE_MS,
} from "./NotificationsHomeCenter";
import { NOTIFICATION_ROW_SETTLE_MS } from "./notification-shade-content";
import {
  notificationPullOvershootOffset,
  PULL_TRAVEL_PX,
} from "./notification-shade-presentation";

let seq = 0;
let restoreMatchMediaForTest: (() => void) | null = null;

describe("notificationScrollFadeEdges", () => {
  it("reports only edges with hidden content across the full scroll range", () => {
    expect(
      notificationScrollFadeEdges({
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 100,
      }),
    ).toEqual({ overflow: false, top: false, bottom: false });
    expect(
      notificationScrollFadeEdges({
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 100,
      }),
    ).toEqual({ overflow: true, top: false, bottom: true });
    expect(
      notificationScrollFadeEdges({
        scrollTop: 80,
        scrollHeight: 300,
        clientHeight: 100,
      }),
    ).toEqual({ overflow: true, top: true, bottom: true });
    expect(
      notificationScrollFadeEdges({
        scrollTop: 199.5,
        scrollHeight: 300,
        clientHeight: 100,
      }),
    ).toEqual({ overflow: true, top: true, bottom: false });
  });
});

function staticMediaQuery(media: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

function installReducedMotionController(initialMatches = false): {
  setMatches: (matches: boolean) => void;
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "matchMedia",
  );
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const media = "(prefers-reduced-motion: reduce)";
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media,
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) =>
      query === media ? mediaQuery : staticMediaQuery(query, false),
  });
  restoreMatchMediaForTest = () => {
    if (originalDescriptor) {
      Object.defineProperty(window, "matchMedia", originalDescriptor);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    restoreMatchMediaForTest = null;
  };
  return {
    setMatches: (nextMatches: boolean) => {
      matches = nextMatches;
      const event = { matches, media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  seq += 1;
  const hex = String(seq).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}` as AgentNotification["id"],
    title: `Notification ${seq}`,
    category: "general",
    // High by default keeps broad fixtures in one priority bucket; ordering
    // tests override it explicitly.
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
  act(() => vi.advanceTimersByTime(40));
  return list;
}

function collapseShade(): HTMLElement {
  const list = screen.getByTestId("home-notification-list");
  fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
  fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
  finishShadeCollapse();
  return list;
}

function finishShadeCollapse(): void {
  act(() => vi.advanceTimersByTime(500));
}

function finishStackFold(): void {
  act(() => vi.advanceTimersByTime(STACK_FOLD_SETTLE_MS + 40));
}

/** Starts gesture-specific scenarios from the user-collapsed shade state. */
function renderRestedNotifications(): ReturnType<typeof render> {
  const result = render(<NotificationsHomeCenter />);
  const list = screen.queryByTestId("home-notification-list");
  if (list?.getAttribute("data-shade-mode") === "expanded") {
    collapseShade();
  }
  return result;
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
  vi.useFakeTimers();
  seq = 0;
  vi.mocked(client.getBaseUrl).mockReset().mockReturnValue("");
});

afterEach(() => {
  cleanup();
  restoreMatchMediaForTest?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  __resetNotificationStoreForTests();
  __resetAuthStatusForTests();
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
});

describe("interrupt priority projection", () => {
  it("keeps only high and urgent notifications visible before expansion", () => {
    expect(isInterruptPriority(makeNotification({ priority: "urgent" }))).toBe(
      true,
    );
    expect(isInterruptPriority(makeNotification({ priority: "high" }))).toBe(
      true,
    );
    expect(isInterruptPriority(makeNotification({ priority: "normal" }))).toBe(
      false,
    );
    expect(isInterruptPriority(makeNotification({ priority: "low" }))).toBe(
      false,
    );
  });

  it("keeps a mixed producer visibly stacked while quiet rows stay folded", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "high",
        source: "mail",
        title: "Important mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "mail",
        title: "Regular mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        source: "mail",
        title: "Quiet mail",
      }),
    );
    renderRestedNotifications();

    const list = screen.getByTestId("home-notification-list");
    const topRow = screen.getByTestId("notification-row");
    expect(topRow.textContent).toContain("Urgent mail");
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByTestId("notification-source-count").textContent).toBe(
      "4",
    );
    expect(screen.getByTestId("notification-stack").style.paddingBottom).toBe(
      "16px",
    );

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 31,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 31,
      clientX: 10,
      clientY: 40,
    });

    expect(screen.getByTestId("notification-row")).toBe(topRow);
    const previewPeeks = screen.getAllByTestId("notification-stack-peek");
    expect(previewPeeks).toHaveLength(2);
    expect(previewPeeks[1].hasAttribute("data-notification-pull-reveal")).toBe(
      false,
    );
    expect(previewPeeks[1].style.opacity).toBe("1");
    const previewTail = Number.parseFloat(
      screen.getByTestId("notification-stack").style.paddingBottom,
    );
    expect(previewTail).toBe(16);

    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 31,
      clientX: 10,
      clientY: 40,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);

    expandShade();
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByTestId("notification-stack").style.paddingBottom).toBe(
      "16px",
    );
    collapseShade();
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("fans a badged interrupt card whose only sibling is still folded", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "calendar",
        title: "Calendar alert",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "calendar",
        title: "Calendar summary",
      }),
    );
    renderRestedNotifications();

    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack").style.paddingBottom).toBe(
      "9px",
    );
    expect(screen.getByTestId("notification-source-count").textContent).toBe(
      "2",
    );
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    fireEvent.click(screen.getByTestId("notification-row"), { detail: 1 });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.scrollTop).toBe(0);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(screen.getByTestId("notification-stack-controls")).toBeTruthy();
    expect(screen.getByText("Calendar summary")).toBeTruthy();
    expect(__getStateForTests().notifications).toHaveLength(2);
    expect(navigateDeepLink).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("notification-stack-collapse"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(
      document.querySelector("[data-notification-stack-closing]"),
    ).toBeTruthy();
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    act(() => vi.advanceTimersByTime(STACK_FOLD_SETTLE_MS - 1));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(
      document.querySelector("[data-notification-stack-closing]"),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(
      document.querySelector("[data-notification-stack-closing]"),
    ).toBeTruthy();
    act(() => vi.advanceTimersByTime(40));
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("rested");
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();

    const center = screen.getByTestId("home-notification-center");
    fireEvent.click(document.body);
    expect(screen.getByTestId("home-notification-center")).toBe(center);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
  });

  it("does not fan a stack from the synthetic click after a vertical touch drag", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "calendar",
        title: "Calendar alert",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "calendar",
        title: "Calendar summary",
      }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(list, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ clientX: 12, clientY: 40 }],
    });
    fireEvent.touchEnd(list, { touches: [] });
    fireEvent.click(screen.getByTestId("notification-row"), { detail: 1 });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();
    expect(__getStateForTests().notifications).toHaveLength(2);

    act(() => vi.advanceTimersByTime(180));
    fireEvent.click(screen.getByTestId("notification-row"), { detail: 1 });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notification-stack-controls")).toBeTruthy();
  });

  it("keeps 50 priority producer stacks visible while folding their quiet siblings", () => {
    for (let i = 0; i < 50; i += 1) {
      const source = `plugin-${i}`;
      __ingestNotificationForTests(
        makeNotification({
          priority: "normal",
          source,
          title: `Quiet ${i}`,
        }),
      );
      __ingestNotificationForTests(
        makeNotification({
          priority: "urgent",
          source,
          title: `Urgent ${i}`,
        }),
      );
    }
    renderRestedNotifications();

    expect(screen.getAllByTestId("notification-row")).toHaveLength(50);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(50);
    expect(screen.getAllByTestId("notification-source-count")).toHaveLength(50);
    expect(screen.queryByTestId("notifications-count")).toBeNull();

    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 33,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 33,
      clientX: 10,
      clientY: 70,
    });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(50);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(50);
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 33,
      clientX: 10,
      clientY: 70,
    });
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(50);

    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(50);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(50);
    collapseShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(50);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(50);
  });

  it("limits a quiet inbox pull preview to the first six producer groups", () => {
    for (let i = 0; i < 10; i += 1) {
      __ingestNotificationForTests(
        makeNotification({
          priority: "normal",
          source: `quiet-plugin-${i}`,
          title: `Quiet ${i}`,
        }),
      );
    }
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(0);

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 32,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 32,
      clientX: 10,
      clientY: 40,
    });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(6);

    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 32,
      clientX: 10,
      clientY: 40,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(6);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(0);
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
    expect(notificationGroupLabel(approval)).toBe("LifeOps");
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
  it("tracks directly between detents and resists only after the endpoint", () => {
    expect(dampenPull(0)).toBe(0);
    expect(dampenPull(8)).toBe(0); // inside the dead zone
    expect(dampenPull(48)).toBe(40);
    expect(dampenPull(52)).toBe(PULL_COMMIT_PX);
    expect(dampenPull(96)).toBe(PULL_TRAVEL_PX);
    expect(dampenPull(124)).toBeCloseTo(97.8, 1);
    expect(dampenPull(2_000)).toBeLessThanOrEqual(PULL_TRAVEL_PX + 32);
  });

  it("preserves resisted travel as signed visual overshoot", () => {
    const overpull = dampenPull(124);

    expect(notificationPullOvershootOffset(PULL_TRAVEL_PX)).toBe(0);
    expect(notificationPullOvershootOffset(overpull)).toBeCloseTo(9.8, 1);
    expect(notificationPullOvershootOffset(-overpull)).toBeCloseTo(-9.8, 1);
  });
});

describe("notificationPullRevealProgress", () => {
  it("tracks full detent travel while staggering later groups", () => {
    expect(notificationPullRevealProgress(0, 0)).toBe(0);
    expect(notificationPullRevealProgress(PULL_TRAVEL_PX / 2, 0)).toBe(0.5);
    expect(notificationPullRevealProgress(PULL_TRAVEL_PX / 2, 2)).toBeLessThan(
      0.5,
    );
    expect(notificationPullRevealProgress(PULL_TRAVEL_PX, 4)).toBe(1);
  });
});

describe("NotificationsHomeCenter", () => {
  it("renders nothing while the empty inbox is still hydrating", () => {
    const { container } = renderRestedNotifications();
    expect(container.firstChild).toBeNull();
  });

  it("renders terminal hydration failure with a working retry", async () => {
    // The retry re-runs hydration through notificationProbesEnabled, which
    // requires an authenticated session before probing the protected inbox
    // API — provide the typed authenticated fixture.
    __setAuthStatusForTests(AUTHENTICATED_OWNER);
    __setHydrationFailureForTests("private transport detail");
    renderRestedNotifications();

    const unavailable = screen.getByTestId("notifications-unavailable");
    expect(unavailable.getAttribute("role")).toBe("alert");
    expect(unavailable.textContent).toContain("Notifications unavailable");
    expect(unavailable.textContent).not.toContain("private transport detail");

    const retry = screen.getByRole("button", { name: "Retry" });
    // Product policy disables focus rings globally (styles.css); the retry
    // button must not carry Tailwind focus/ring utilities — guards the
    // no-focus-ring-gate at the component level.
    const retryClass = retry.getAttribute("class") ?? "";
    expect(retryClass).not.toMatch(
      /(?:^|\s)(?:focus|focus-visible|focus-within):/,
    );
    expect(retryClass).not.toMatch(/(?:^|\s)!?ring-/);

    vi.mocked(client.getBaseUrl).mockClear();
    vi.mocked(client.listNotifications).mockClear();
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });

    // Retry passes back through the async hydrating state (which renders
    // nothing) before the hydrated-empty surface mounts. The suite runs fake
    // timers, so flush timers + microtasks explicitly rather than waitFor.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.queryByTestId("notifications-unavailable")).toBeNull();
    expect(screen.queryByTestId("notifications-empty")).not.toBeNull();
    // The retry actually probed: the base-URL gate ran and exactly one inbox
    // hydrate request went out (payload-to-effect, not just rendered state).
    expect(client.getBaseUrl).toHaveBeenCalled();
    expect(client.listNotifications).toHaveBeenCalledTimes(1);
  });

  it("does not probe the inbox API on retry against the agentless Cloud base", async () => {
    // The no-probe branch of notificationProbesEnabled: a bare Cloud
    // control-plane authority has no standalone-agent inbox API, so retry must
    // not issue a hydrate request even while authenticated.
    __setAuthStatusForTests(AUTHENTICATED_OWNER);
    vi.mocked(client.getBaseUrl).mockReturnValue("https://cloud.eliza.app");
    __setHydrationFailureForTests("private transport detail");
    renderRestedNotifications();

    const retry = screen.getByRole("button", { name: "Retry" });
    vi.mocked(client.getBaseUrl).mockClear();
    vi.mocked(client.listNotifications).mockClear();
    await act(async () => {
      fireEvent.click(retry);
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // The base-URL gate ran and refused: no hydrate request left the client,
    // and the hydrated-empty surface never mounts.
    expect(client.getBaseUrl).toHaveBeenCalled();
    expect(client.listNotifications).not.toHaveBeenCalled();
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });

  it("applies directional fades only where notification content is hidden", () => {
    __ingestNotificationForTests(makeNotification());
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
    });

    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(list.hasAttribute("data-scroll-overflow")).toBe(true);
    expect(list.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(list.hasAttribute("data-scroll-fade-bottom")).toBe(true);
    expect(list.className).not.toContain("scroll-fade");

    list.scrollTop = 80;
    fireEvent.scroll(list);
    expect(list.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(list.hasAttribute("data-scroll-fade-bottom")).toBe(true);

    list.scrollTop = 200;
    fireEvent.scroll(list);
    expect(list.hasAttribute("data-scroll-fade-top")).toBe(true);
    expect(list.hasAttribute("data-scroll-fade-bottom")).toBe(false);

    Object.defineProperty(list, "scrollHeight", {
      configurable: true,
      value: 100,
    });
    fireEvent.scroll(list);
    expect(list.hasAttribute("data-scroll-overflow")).toBe(false);
    expect(list.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(list.hasAttribute("data-scroll-fade-bottom")).toBe(false);
  });

  it("reveals a subtle empty status through the normal pull gesture", () => {
    __setHydratedForTests(true);
    renderRestedNotifications();
    const center = screen.getByTestId("home-notification-center");
    const list = screen.getByTestId("home-notification-list");
    const empty = screen.getByTestId("notifications-empty");

    expect(center.className).toContain("min-h-14");
    expect(list.className).not.toContain("scroll-fade");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(empty.style.opacity).toBe("0");
    expect(empty.getAttribute("aria-hidden")).toBe("true");
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

    expect(screen.getByTestId("notifications-empty")).toBe(empty);
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
    act(() => vi.advanceTimersByTime(16));
    const restingEmptyStyle = {
      opacity: empty.style.opacity,
      transform: empty.style.transform,
    };
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 300,
    });
    act(() => vi.advanceTimersByTime(16));
    expect(empty.style.opacity).toBe(restingEmptyStyle.opacity);
    expect(empty.style.transform).not.toBe(restingEmptyStyle.transform);
    expect(list.style.transform).toBe("");
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 300,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("1");
    expect(empty.style.transform).toBe("translate3d(0, 0px, 0)");
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();

    fireEvent.click(document.body);
    const fadingEmpty = screen.getByTestId("notifications-empty");
    expect(fadingEmpty.style.opacity).toBe("0");
    expect(fadingEmpty.className).toContain("eliza-notif-shade-transition");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId("notifications-empty")).toBe(fadingEmpty);
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");

    // Re-open for the directional swipe-collapse assertions below.
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
      clientY: 140,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 3,
      clientX: 10,
      clientY: 140,
    });

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
    finishShadeCollapse();

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notifications-empty")).toBe(empty);
    expect(empty.style.opacity).toBe("0");
    expect(empty.getAttribute("aria-hidden")).toBe("true");
  });

  it("supports the native touch path while the hydrated inbox is empty", () => {
    __setHydratedForTests(true);
    renderRestedNotifications();
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
    finishShadeCollapse();

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notifications-empty").style.opacity).toBe("0");
  });

  it("folds quieter rows after the user hides the full inbox", () => {
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
        priority: "normal",
        readAt: Date.now(),
        source: "workflow",
      }),
    );
    renderRestedNotifications();
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByText("Reminder fired")).toBeTruthy();
    expect(screen.queryByText("Deploy approved")).toBeNull();
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    // The header is a bare eyebrow: no numeric unread badge next to the label.
    expect(screen.queryByTestId("notifications-unread-badge")).toBeNull();
    expect(screen.getByText("Deploy approved")).toBeTruthy();
  });

  it("carries no read-state chrome — no unread dot, no data-unread attribute", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Disk almost full" }),
    );
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(__getStateForTests().notifications).toHaveLength(0);
    expect(screen.queryByTestId("notification-row-options")).toBeNull();
  });

  it("tap never navigates an unsafe deep link but still clears the row", () => {
    __ingestNotificationForTests(
      makeNotification({ deepLink: "javascript:alert(1)" }),
    );
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
    expect(screen.getByTestId("notification-source-count").textContent).toBe(
      "99+",
    );
    // Stacks persist through the shade change; fan via the front card.
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(100);
  });

  it("renders rows with no accent rail at any priority (lock-screen restraint)", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Urgent" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", title: "Quiet one" }),
    );
    renderRestedNotifications();
    expandShade();
    fireEvent.click(screen.getByTestId("notification-row"));
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
    renderRestedNotifications();
    expandShade();
    // Coalesced arrivals speak through their title/body; no bare number rides
    // the notification header.
    expect(screen.queryByTestId("notification-count-chip")).toBeNull();
  });
});

// ── Z-stacked groups (expanded shade) ───────────────────────────────────────
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
    renderRestedNotifications();
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expandShade();
    // One interactive card — the group's highest-priority row.
    const rows = screen.getAllByTestId("notification-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Top urgent");
    // The rest of the group peeks from beneath as solid depth cues.
    const stack = screen.getByTestId("notification-stack");
    expect(stack).toBeTruthy();
    const peeks = screen.getAllByTestId("notification-stack-peek");
    expect(peeks).toHaveLength(2);
    for (const peek of peeks) {
      expect(peek.className).toContain("eliza-notif-glass");
      // Peeks are decorative depth cues. The front card is the stack's one
      // keyboard/screen-reader control.
      expect(peek.tagName).toBe("DIV");
      expect(peek.getAttribute("aria-hidden")).toBe("true");
      expect(peek.className).toContain("pointer-events-none");
      expect(peek.style.filter).toBe("");
      expect(peek.className).toContain("inset-0");
      expect(peek.closest("[data-notif-row]")).toBe(
        rows[0]?.closest("[data-notif-row]"),
      );
    }
    // Deeper cards sit lower in Z and protrude further.
    expect(Number(peeks[0].style.zIndex)).toBeGreaterThan(
      Number(peeks[1].style.zIndex),
    );
    expect(peeks[0].style.opacity).toBe("1");
    expect(peeks[1].style.opacity).toBe("1");
    expect(peeks[0].style.transform).toBe("translateY(7px) scale(0.985)");
    expect(peeks[1].style.transform).toBe("translateY(14px) scale(0.97)");
    expect(stack.style.paddingBottom).toBe("16px");
    // The producer tile is vertically centered and carries the stack total.
    const sourceIcon = screen.getByTestId("notification-source-icon");
    expect(sourceIcon.className).toContain("h-10");
    expect(sourceIcon.className).toContain("w-10");
    expect(sourceIcon.className).toContain("items-center");
    const count = screen.getByTestId("notification-source-count");
    expect(count.textContent).toBe("3");
    expect(count.className).toContain("min-w-5");
    expect(count.className).toContain("tabular-nums");
    expect(
      screen.getAllByRole("button", {
        name: "Top urgent. Show all 3 Test notifications",
      }),
    ).toHaveLength(1);
  });

  it("stacks cap their visual depth at two peeks", () => {
    for (let i = 0; i < 5; i++) {
      __ingestNotificationForTests(makeNotification({ priority: "high" }));
    }
    renderRestedNotifications();
    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("a single-row group renders flat — no stack, no peeks", () => {
    __ingestNotificationForTests(makeNotification({ title: "Solo" }));
    renderRestedNotifications();
    expect(screen.getByTestId("notification-row")).toBeTruthy();
    expandShade();
    expect(screen.getByTestId("notification-row")).toBeTruthy();
    expect(screen.queryByTestId("notification-stack")).toBeNull();
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
  });

  it("tapping the expanded stack top fans it instead of opening its deep link", () => {
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
    renderRestedNotifications();
    expandShade();
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

  it("expanding the shade keeps the stacks; activating the front card fans the group in place", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "normal" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    renderRestedNotifications();
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    // Pulling the shade open reveals more groups but never flattens a stack.
    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    // The front card is the stack's single interactive opener.
    const openingCard = screen.getByTestId("notification-row");
    openingCard.focus();
    fireEvent.click(openingCard, { detail: 0 });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    const enteringControls = screen.getByTestId("notification-stack-controls");
    expect(enteringControls.className).toContain("px-2");
    const groupContent = document.querySelector(
      "[data-notification-group-content]",
    ) as HTMLElement;
    const closingPeeks = Array.from(
      document.querySelectorAll<HTMLElement>("[data-notification-stack-peek]"),
    );
    expect(enteringControls.style.height).toBe("0px");
    expect(enteringControls.style.opacity).toBe("0");
    expect(groupContent.style.paddingBottom).toBe("16px");
    expect(closingPeeks).toHaveLength(2);
    expect(closingPeeks.every((peek) => peek.style.opacity === "1")).toBe(true);
    const enteringRows = screen
      .getAllByTestId("notification-row")
      .slice(1)
      .map((row) => row.closest("[data-notif-row]") as HTMLElement);
    expect(enteringRows.every((row) => row.style.opacity === "0")).toBe(true);

    act(() => vi.advanceTimersByTime(40));
    expect(enteringControls.style.height).toBe("36px");
    expect(enteringControls.style.opacity).toBe("1");
    expect(enteringRows.every((row) => row.style.opacity === "1")).toBe(true);
    expect(groupContent.style.paddingBottom).toBe("16px");
    expect(closingPeeks.every((peek) => peek.style.opacity === "0")).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("notification-stack-collapse"),
    );
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
    expect(
      screen.getByTestId("notification-stack-clear").dataset.confirming,
    ).toBeUndefined();
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    const controls = screen.getByTestId("notification-stack-controls");
    expect(controls.parentElement?.firstElementChild).toBe(controls);
    expect(
      controls.compareDocumentPosition(
        screen.getAllByTestId("notification-row")[0],
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("notification-stack-collapse"), {
      detail: 0,
    });
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(enteringControls.style.height).toBe("0px");
    expect(enteringControls.style.opacity).toBe("0");
    expect(groupContent.style.paddingBottom).toBe("16px");
    expect(closingPeeks.every((peek) => peek.style.opacity === "1")).toBe(true);
    expect(enteringControls.getAttribute("aria-hidden")).toBe("true");
    expect(enteringControls.hasAttribute("inert")).toBe(true);
    expect(
      closingPeeks.every(
        (peek) =>
          peek.getAttribute("aria-hidden") === "true" &&
          peek.className.includes("pointer-events-none"),
      ),
    ).toBe(true);
    expect(
      screen
        .getByTestId("notification-stack-collapse")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("notification-stack-collapse"),
    );
    act(() => vi.advanceTimersByTime(STACK_FOLD_SETTLE_MS - 1));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    act(() => vi.advanceTimersByTime(40));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    expect(screen.queryByTestId("notification-stack-collapse")).toBeNull();
    expect(document.activeElement).toBe(openingCard);
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
  });

  it("hands focus from a hidden stack opener to Show Less and back", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "normal" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    renderRestedNotifications();
    expandShade();

    const opener = screen.getByTestId("notification-row");
    opener.focus();
    fireEvent.click(opener);
    const showLess = screen.getByTestId("notification-stack-collapse");
    expect(document.activeElement).toBe(showLess);

    fireEvent.click(showLess);
    expect(document.activeElement).toBe(showLess);
    finishStackFold();
    expect(document.activeElement).toBe(opener);
    expect(opener.getAttribute("aria-hidden")).toBeNull();
    expect(opener.tabIndex).toBe(0);
  });

  it("fanning an expanded stack keeps the shade open", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B", priority: "high" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "C", priority: "urgent" }),
    );
    renderRestedNotifications();
    expandShade();
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    const list = screen.getByTestId("home-notification-list");
    expect(list.className).toContain("touch-pan-y");
    expect(list.className).toContain("overflow-x-hidden");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();
  });

  it("does not let an older fold auto-close a stack opened during its settle", () => {
    __ingestNotificationForTests(
      makeNotification({ title: "A older", source: "calendar" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "A newest", source: "calendar" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B older", source: "mail" }),
    );
    __ingestNotificationForTests(
      makeNotification({ title: "B newest", source: "mail" }),
    );
    renderRestedNotifications();
    const groupA = screen
      .getByText("A newest")
      .closest<HTMLElement>("[data-notification-group]");
    const groupB = screen
      .getByText("B newest")
      .closest<HTMLElement>("[data-notification-group]");
    expect(groupA).toBeTruthy();
    expect(groupB).toBeTruthy();

    fireEvent.click(
      groupA?.querySelector<HTMLElement>(
        '[data-testid="notification-row"]',
      ) as HTMLElement,
    );
    act(() => vi.advanceTimersByTime(40));
    fireEvent.click(
      groupA?.querySelector<HTMLElement>(
        '[data-testid="notification-stack-collapse"]',
      ) as HTMLElement,
    );
    fireEvent.click(
      groupB?.querySelector<HTMLElement>(
        '[data-testid="notification-row"]',
      ) as HTMLElement,
    );
    act(() => vi.advanceTimersByTime(40));
    expect(screen.getAllByTestId("notification-stack-controls")).toHaveLength(
      2,
    );

    finishStackFold();
    expect(screen.getAllByTestId("notification-stack-controls")).toHaveLength(
      1,
    );
    expect(
      groupB?.querySelector('[data-testid="notification-stack-controls"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
    finishShadeCollapse();
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
  });

  it("finishes an in-flight fold immediately when reduced motion turns on", () => {
    const motionPreference = installReducedMotionController();
    __ingestNotificationForTests(makeNotification({ title: "A" }));
    __ingestNotificationForTests(makeNotification({ title: "B" }));
    __ingestNotificationForTests(makeNotification({ title: "C" }));
    renderRestedNotifications();
    expandShade();
    fireEvent.click(screen.getByTestId("notification-row"));
    act(() => vi.advanceTimersByTime(40));
    fireEvent.click(screen.getByTestId("notification-stack-collapse"));
    expect(
      document.querySelector("[data-notification-stack-closing]"),
    ).toBeTruthy();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);

    act(() => motionPreference.setMatches(true));
    expect(
      document.querySelector("[data-notification-stack-closing]"),
    ).toBeNull();
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");

    act(() => vi.advanceTimersByTime(STACK_FOLD_SETTLE_MS + 250));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(
      screen
        .getByTestId("home-notification-list")
        .getAttribute("data-shade-mode"),
    ).toBe("expanded");
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
    renderRestedNotifications();
    expandShade();
    const stack = screen.getByTestId("notification-stack");
    fireEvent.click(
      stack.querySelector('[data-testid="notification-row"]') as HTMLElement,
    );
    const clear = screen.getByTestId("notification-stack-clear");
    expect(clear.dataset.confirming).toBeUndefined();
    expect(clear.className).toContain("w-8");
    expect(clear.textContent).not.toContain("Clear all");
    fireEvent.click(clear);
    expect(clear.dataset.confirming).toBe("true");
    expect(__getStateForTests().notifications).toHaveLength(3);
    fireEvent.click(clear);
    expect(__getStateForTests().notifications).toHaveLength(1);
    expect(screen.getByText("Keep")).toBeTruthy();
  });

  it("a vertical drag on an expanded stack never fans it", () => {
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
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    const stack = screen.getByTestId("notification-stack");
    // The stack has no drag handling of its own. A downward drag bubbles to the
    // already-expanded shade as a directional no-op; fanning remains tap-only.
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
    expect(screen.getByTestId("notification-stack")).toBeTruthy();
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("reveals and smoothly promotes the next real card when swiping a stack top", () => {
    vi.useFakeTimers();
    try {
      __ingestNotificationForTests(
        makeNotification({ title: "Below", priority: "high" }),
      );
      __ingestNotificationForTests(
        makeNotification({ title: "On top", priority: "urgent" }),
      );
      renderRestedNotifications();
      expandShade();
      const swipe = screen.getByTestId("notification-row-swipe");
      const peek = screen.getByTestId("notification-stack-peek");
      const preview = peek.querySelector<HTMLElement>(
        "[data-notification-stack-preview-content]",
      );
      expect(
        peek
          .querySelector("[data-notification-stack-preview-title]")
          ?.getAttribute("data-notification-stack-preview-title"),
      ).toBe("Below");
      expect(preview?.style.visibility).toBe("hidden");
      expect(preview?.style.opacity).toBe("0");
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
      expect(preview?.style.visibility).toBe("visible");
      expect(preview?.style.opacity).toBe("1");
      step("pointerMove", 150);
      expect(swipe.style.transform).toContain("translateX(130px)");
      expect(peek.style.transform).toContain("translateY(7px)");
      step("pointerUp", 150);
      expect(swipe.style.transform).toContain("translateX(120%)");
      expect(peek.getAttribute("data-swipe-promoting")).toBe("");
      expect(peek.style.transform).toContain("translateY(0px) scale(1)");
      expect(preview?.style.visibility).toBe("visible");
      expect(preview?.style.opacity).toBe("1");

      act(() => {
        vi.advanceTimersByTime(NOTIFICATION_ROW_SETTLE_MS);
      });
      expect(screen.getByTestId("notification-row").textContent).toContain(
        "On top",
      );
      act(() => {
        vi.advanceTimersByTime(24);
      });
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

  it("smoothly closes the vacated gap after dismissing a fanned stack row", () => {
    vi.useFakeTimers();
    try {
      __ingestNotificationForTests(
        makeNotification({ title: "Below", priority: "high" }),
      );
      __ingestNotificationForTests(
        makeNotification({ title: "On top", priority: "urgent" }),
      );
      renderRestedNotifications();
      expandShade();
      fireEvent.click(screen.getByTestId("notification-row"));
      const rows = screen.getAllByTestId("notification-row-swipe");
      expect(rows).toHaveLength(2);
      const outgoing = rows[0] as HTMLElement;
      const item = outgoing.closest("li") as HTMLElement;
      const step = (type: string, x: number) =>
        (
          fireEvent as unknown as Record<
            string,
            (element: Element, init: unknown) => void
          >
        )[type](outgoing, {
          clientX: x,
          clientY: 22,
          pointerId: 4,
          pointerType: "touch",
        });

      step("pointerDown", 150);
      step("pointerMove", 30);
      step("pointerUp", 30);
      expect(outgoing.style.transform).toContain("translateX(-120%)");
      expect(item.getAttribute("data-swipe-collapsing")).toBe("");
      expect(item.style.gridTemplateRows).toBe("0fr");
      expect(item.style.marginBottom).toBe("-6px");

      act(() => {
        vi.advanceTimersByTime(NOTIFICATION_ROW_SETTLE_MS + 24);
      });
      expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
      expect(screen.getByTestId("notification-row").textContent).toContain(
        "Below",
      );
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

  it("shows all notifications by default without expand or collapse controls", () => {
    seedTriage();
    const onShadeOccupancyChange = vi.fn();
    render(
      <NotificationsHomeCenter
        onShadeOccupancyChange={onShadeOccupancyChange}
      />,
    );

    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-occupies-home")).toBe(false);
    expect(onShadeOccupancyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.getByTestId("notification-source-count").textContent).toBe(
      "3",
    );
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-count-button")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();
  });

  it("opens notifications that arrive after an initially empty render", () => {
    __setHydratedForTests(true);
    render(<NotificationsHomeCenter />);

    act(() => {
      __ingestNotificationForTests(
        makeNotification({ priority: "normal", title: "Hydrated alert" }),
      );
    });

    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByText("Hydrated alert")).toBeTruthy();
  });

  it("opens an empty shade once for each new shell request id", () => {
    __setHydratedForTests(true);
    const onOpenRequestHandled = vi.fn();
    const { rerender } = render(
      <NotificationsHomeCenter
        openRequestId={1}
        onOpenRequestHandled={onOpenRequestHandled}
      />,
    );
    const list = screen.getByTestId("home-notification-list");
    const empty = screen.getByTestId("notifications-empty");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(empty.getAttribute("aria-hidden")).toBeNull();
    expect(empty.style.opacity).toBe("1");
    expect(onOpenRequestHandled).toHaveBeenCalledExactlyOnceWith(1);

    collapseShade();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");

    rerender(
      <NotificationsHomeCenter
        openRequestId={1}
        onOpenRequestHandled={onOpenRequestHandled}
      />,
    );
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(1);

    rerender(
      <NotificationsHomeCenter
        openRequestId={2}
        onOpenRequestHandled={onOpenRequestHandled}
      />,
    );
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(empty.getAttribute("aria-hidden")).toBeNull();
    expect(empty.style.opacity).toBe("1");
    expect(onOpenRequestHandled).toHaveBeenLastCalledWith(2);
    expect(onOpenRequestHandled).toHaveBeenCalledTimes(2);
  });

  it("ignores a chat pull release over the notification area", () => {
    seedTriage();
    render(
      <>
        <NotificationsHomeCenter />
        <button
          type="button"
          data-chat-gesture-surface=""
          data-testid="chat-pull-handle"
        >
          Chat pull handle
        </button>
      </>,
    );
    const list = screen.getByTestId("home-notification-list");
    const chatHandle = screen.getByTestId("chat-pull-handle");

    fireEvent.pointerDown(chatHandle, {
      pointerType: "touch",
      pointerId: 31,
      clientY: 600,
    });
    fireEvent.pointerMove(chatHandle, {
      pointerType: "touch",
      pointerId: 31,
      clientY: 240,
    });
    fireEvent.pointerUp(chatHandle, {
      pointerType: "touch",
      pointerId: 31,
      clientY: 240,
    });
    fireEvent.click(chatHandle, { detail: 1, clientY: 240 });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
  });

  it("does not collapse for a portaled chat action control", () => {
    seedTriage();
    render(
      <>
        <NotificationsHomeCenter />
        <div data-chat-overlay-control="">
          <button type="button">Upload file</button>
        </div>
      </>,
    );
    const list = screen.getByTestId("home-notification-list");

    fireEvent.click(screen.getByText("Upload file"), { detail: 1 });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
  });

  it("does not let a mouse drag on chat controls pull the notification shade", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
        <button
          type="button"
          data-chat-gesture-surface=""
          data-testid="chat-pull-handle"
        >
          Chat pull handle
        </button>
      </div>,
    );
    collapseShade();
    const list = screen.getByTestId("home-notification-list");
    const chatHandle = screen.getByTestId("chat-pull-handle");

    fireEvent.pointerDown(chatHandle, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 32,
      clientX: 180,
      clientY: 300,
    });
    fireEvent.pointerMove(chatHandle, {
      pointerType: "mouse",
      pointerId: 32,
      clientX: 180,
      clientY: 500,
    });
    fireEvent.pointerUp(chatHandle, {
      pointerType: "mouse",
      pointerId: 32,
      clientX: 180,
      clientY: 500,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
  });

  it("keeps nested chat controls isolated from touch, wheel, and pen shade gestures", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
        <button type="button" data-chat-gesture-surface="">
          <span data-testid="nested-chat-control">Chat action icon</span>
        </button>
      </div>,
    );
    const list = collapseShade();
    const nestedControl = screen.getByTestId("nested-chat-control");

    fireEvent.touchStart(nestedControl, {
      touches: [{ identifier: 71, clientX: 180, clientY: 250 }],
    });
    fireEvent.touchMove(nestedControl, {
      touches: [{ identifier: 71, clientX: 180, clientY: 520 }],
    });
    fireEvent.touchEnd(nestedControl, {
      touches: [],
      changedTouches: [{ identifier: 71, clientX: 180, clientY: 520 }],
    });
    fireEvent.wheel(nestedControl, { deltaY: -(PULL_COMMIT_PX + 20) });
    fireEvent.pointerDown(nestedControl, {
      pointerType: "pen",
      isPrimary: true,
      pointerId: 72,
      clientX: 180,
      clientY: 250,
    });
    fireEvent.pointerMove(nestedControl, {
      pointerType: "pen",
      pointerId: 72,
      clientX: 180,
      clientY: 520,
    });
    fireEvent.pointerUp(nestedControl, {
      pointerType: "pen",
      pointerId: 72,
      clientX: 180,
      clientY: 520,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);

    expandShade();
    fireEvent.touchStart(nestedControl, {
      touches: [{ identifier: 73, clientX: 180, clientY: 520 }],
    });
    fireEvent.touchMove(nestedControl, {
      touches: [{ identifier: 73, clientX: 180, clientY: 220 }],
    });
    fireEvent.touchEnd(nestedControl, {
      touches: [],
      changedTouches: [{ identifier: 73, clientX: 180, clientY: 220 }],
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
  });

  it("keeps the priority row mounted while an outside tap fades quiet groups", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "files",
        title: "Files updated",
      }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    const priorityRow = screen.getByTestId("notification-row");
    expandShade();
    const quietRow = screen.getByText("Files updated").closest("li");
    const quietGroup = quietRow
      ?.closest("[data-notification-group]")
      ?.querySelector<HTMLElement>("[data-notification-group-content]");

    fireEvent.click(document.body);

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByText("Urgent mail").closest("li")).toBe(
      priorityRow.closest("li"),
    );
    // The shell stays mounted at full opacity so its rounded rim does not
    // darken; the card information fades through the shared settle variable.
    expect(quietGroup?.style.opacity).toBe("1");
    expect(
      Number.parseFloat(
        quietGroup?.style.getPropertyValue(
          "--eliza-notif-group-content-visibility",
        ) ?? "1",
      ),
    ).toBeLessThan(1);
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notification-row")).toBe(priorityRow);
    expect(screen.queryByText("Files updated")).toBeNull();
  });

  it("closes every card while retaining priority shells for stable geometry", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    const priorityRow = screen.getByTestId("notification-row");
    expandShade();
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 81,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 81,
      clientX: 12,
      clientY: 20,
    });

    expect(screen.getByTestId("notification-row")).toBe(priorityRow);
    const prioritySurface = priorityRow.closest<HTMLElement>(
      '[data-testid="notification-row-swipe"]',
    );
    const priorityGroupContent = priorityRow.closest<HTMLElement>(
      "[data-notification-group-content]",
    );
    expect(prioritySurface?.className).toContain("eliza-notif-glass");
    expect(prioritySurface?.style.opacity).toBe("1");
    expect(priorityGroupContent?.style.opacity).toBe("1");
    expect(
      Number.parseFloat(
        priorityGroupContent?.style.getPropertyValue(
          "--eliza-notif-group-content-visibility",
        ) ?? "1",
      ),
    ).toBeLessThan(1);
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    const peeks = screen.getAllByTestId("notification-stack-peek");
    expect(Number.parseFloat(peeks[0].style.opacity)).toBeLessThan(1);
    expect(Number.parseFloat(peeks[1].style.opacity)).toBeLessThan(1);

    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 81,
      clientX: 12,
      clientY: 20,
    });
    expect(list.getAttribute("data-shade-dragging")).toBeNull();
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    expect(priorityGroupContent?.style.opacity).toBe("1");
    expect(
      priorityGroupContent?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("0");
    const settledContentRule = list.parentElement
      ?.querySelector("style")
      ?.textContent?.match(
        /\.eliza-notif-scroll\[data-shade-settling\][^{}]*\.eliza-notif-row-content\s*\{([^}]*)\}/,
      )?.[1];
    expect(settledContentRule).toContain("transition:");
    expect(settledContentRule).toContain("opacity");
    expect(settledContentRule).not.toContain(
      "--eliza-notif-group-content-visibility",
    );
    const settledMaterialRule = list.parentElement
      ?.querySelector("style")
      ?.textContent?.match(
        /\.eliza-notif-scroll\[data-shade-mode="expanded"\]\[data-shade-settling\][^{}]*\.eliza-notif-glass::after\s*\{([^}]*)\}/,
      )?.[1];
    expect(settledMaterialRule).toContain("transition: opacity");
    expect(list.parentElement?.querySelector("style")?.textContent).toContain(
      '.eliza-notif-scroll[data-shade-mode="expanded"]:is([data-shade-dragging], [data-shade-settling]) [data-notification-group-content] .eliza-notif-glass',
    );
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.getByTestId("notification-row")).toBe(priorityRow);
    expect(priorityGroupContent?.style.opacity).toBe("0");
    expect(priorityGroupContent?.style.transition).toBe("none");
    expect(
      priorityGroupContent
        ?.closest("[data-notification-group]")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      priorityGroupContent
        ?.closest("[data-notification-group]")
        ?.hasAttribute("inert"),
    ).toBe(true);
  });

  it("keeps the same card material through a reversible upward drag", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "files",
        title: "Files updated",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        source: "agent",
        title: "Agent summary",
      }),
    );
    renderRestedNotifications();
    const list = expandShade();
    const filesGroup = screen
      .getByText("Files updated")
      .closest("[data-notification-group]")
      ?.querySelector<HTMLElement>("[data-notification-group-content]");
    const filesSurface = screen
      .getByText("Files updated")
      .closest<HTMLElement>('[data-testid="notification-row-swipe"]');
    const agentGroup = screen
      .getByText("Agent summary")
      .closest("[data-notification-group]")
      ?.querySelector<HTMLElement>("[data-notification-group-content]");
    const agentSurface = screen
      .getByText("Agent summary")
      .closest<HTMLElement>('[data-testid="notification-row-swipe"]');
    const mailGroup = screen
      .getByText("Urgent mail")
      .closest("[data-notification-group]")
      ?.querySelector<HTMLElement>("[data-notification-group-content]");
    const filesContent = filesSurface?.querySelector<HTMLElement>(
      ".eliza-notif-row-content",
    );

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 83,
      clientX: 12,
      clientY: 160,
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(filesSurface?.style.transform).toBe("");
    expect(filesContent?.style.transform).toBe("");
    expect(filesContent?.className).not.toContain("active:scale");
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 83,
      clientX: 12,
      clientY: 116,
    });

    expect(list.hasAttribute("data-shade-dragging")).toBe(true);
    // Count and clear controls own no layout space, so gesture presentation
    // must never move an already-visible priority stack to compensate for them.
    expect(mailGroup?.style.transform).toBe("translate3d(0, 0px, 0)");
    const css = list.parentElement?.querySelector("style")?.textContent ?? "";
    const activeDragRule = css.match(
      /\.eliza-notif-scroll\[data-shade-dragging\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(activeDragRule).not.toContain("mask-image");
    const releaseSettleRule = css.match(
      /\.eliza-notif-scroll\[data-shade-release-settling\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(releaseSettleRule).not.toContain("mask-image");
    // A pull may animate compositor properties, but changing which element
    // paints the fill produces a visible first-frame color/rim discontinuity.
    const gestureMaterialRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(
        (match) =>
          match[1]?.includes("data-shade-dragging") ||
          match[1]?.includes("data-shade-settling") ||
          match[1]?.includes("data-notification-shade-cancelling"),
      )
      .map((match) => match[2] ?? "")
      .join("\n");
    expect(gestureMaterialRules).not.toMatch(
      /background-(?:color|image)|backdrop-filter|mask-image/,
    );

    let filesOpacity = Number.parseFloat(filesGroup?.style.opacity ?? "1");
    let agentOpacity = Number.parseFloat(agentGroup?.style.opacity ?? "1");
    expect(filesOpacity).toBe(1);
    expect(agentOpacity).toBe(1);
    expect(filesSurface?.style.opacity).toBe("1");
    expect(agentSurface?.style.opacity).toBe("1");
    let filesContentOpacity = Number.parseFloat(
      filesGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "1",
    );
    let agentContentOpacity = Number.parseFloat(
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "1",
    );
    expect(filesContentOpacity).toBeGreaterThan(0);
    expect(filesContentOpacity).toBeLessThan(1);
    expect(agentContentOpacity).toBeLessThan(filesContentOpacity);
    const filesSurfaceOpacity = Number.parseFloat(
      filesGroup?.style.getPropertyValue(
        "--eliza-notif-group-surface-visibility",
      ) ?? "0",
    );
    expect(filesSurfaceOpacity).toBeCloseTo(filesContentOpacity, 6);
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 83,
      clientX: 12,
      clientY: 92,
    });
    act(() => vi.advanceTimersByTime(20));
    filesOpacity = Number.parseFloat(filesGroup?.style.opacity ?? "1");
    agentOpacity = Number.parseFloat(agentGroup?.style.opacity ?? "1");
    expect(filesOpacity).toBe(1);
    expect(agentOpacity).toBe(1);
    filesContentOpacity = Number.parseFloat(
      filesGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "1",
    );
    agentContentOpacity = Number.parseFloat(
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "1",
    );
    expect(filesContentOpacity).toBeGreaterThan(0);
    expect(filesContentOpacity).toBeLessThan(1);
    expect(agentContentOpacity).toBeGreaterThan(0);
    expect(agentContentOpacity).toBeLessThan(filesContentOpacity);

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 83,
      clientX: 12,
      clientY: 160,
    });
    act(() => vi.advanceTimersByTime(20));
    expect(filesGroup?.style.opacity).toBe("1");
    expect(agentGroup?.style.opacity).toBe("1");
    expect(
      filesGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("");
    expect(
      filesGroup?.style.getPropertyValue(
        "--eliza-notif-group-surface-visibility",
      ),
    ).toBe("");
    expect(
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("");
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 83,
      clientX: 12,
      clientY: 160,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("hands content fade from cancel through immediate re-grab and committed settle", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "files",
        title: "Files updated",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        source: "agent",
        title: "Agent summary",
      }),
    );
    renderRestedNotifications();
    const list = expandShade();
    const center = screen.getByTestId("home-notification-center");
    const agentGroup = screen
      .getByText("Agent summary")
      .closest("[data-notification-group]")
      ?.querySelector<HTMLElement>("[data-notification-group-content]");
    const shadeCss = center.querySelector("style")?.textContent ?? "";
    expect(shadeCss).toContain(
      ".eliza-notif-scroll:is([data-shade-dragging], [data-shade-settling])",
    );
    expect(shadeCss).toContain(
      "[data-notification-shade-cancelling] .eliza-notif-row-content",
    );
    expect(shadeCss).toContain(
      ".eliza-notif-scroll[data-shade-dragging] [data-notification-group-content] .eliza-notif-row-content",
    );

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 85,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 85,
      clientX: 12,
      clientY: 132,
    });
    const cancelledContentOpacity =
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "";
    expect(Number.parseFloat(cancelledContentOpacity)).toBeLessThan(1);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 85,
      clientX: 12,
      clientY: 132,
    });

    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      true,
    );
    expect(
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe(cancelledContentOpacity);

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 86,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 86,
      clientX: 12,
      clientY: 20,
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(true);
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );
    const committedContentOpacity =
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ) ?? "";
    expect(Number.parseFloat(committedContentOpacity)).toBeLessThan(1);
    expect(Number.parseFloat(committedContentOpacity)).toBeLessThan(
      Number.parseFloat(cancelledContentOpacity),
    );
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 86,
      clientX: 12,
      clientY: 20,
    });

    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    expect(agentGroup?.style.opacity).toBe("1");
    expect(
      agentGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe(committedContentOpacity);
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("clears gesture-owned visibility before a reopened shade starts its next close", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "files",
        title: "Files updated",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        source: "agent",
        title: "Agent summary",
      }),
    );
    render(<NotificationsHomeCenter />);
    const list = screen.getByTestId("home-notification-list");
    const priorityRow = screen
      .getByText("Urgent mail")
      .closest<HTMLElement>('[data-testid="notification-row"]');
    if (!priorityRow) throw new Error("Expected the urgent notification row");
    const priorityGroup = priorityRow.closest<HTMLElement>(
      "[data-notification-group-content]",
    );
    const prioritySurface = priorityRow.closest<HTMLElement>(
      '[data-testid="notification-row-swipe"]',
    );
    const initialMaterial = {
      groupOpacity: priorityGroup?.style.opacity,
      groupTransform: priorityGroup?.style.transform,
      surfaceOpacity: prioritySurface?.style.opacity,
      surfaceTransform: prioritySurface?.style.transform,
    };

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 87,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 87,
      clientX: 12,
      clientY: 20,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 87,
      clientX: 12,
      clientY: 20,
    });
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    finishShadeCollapse();

    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(
      priorityGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("");
    expect(
      priorityGroup?.style.getPropertyValue(
        "--eliza-notif-group-surface-visibility",
      ),
    ).toBe("");
    expect(
      priorityGroup
        ?.querySelector<HTMLElement>("[data-notification-disposable-row]")
        ?.style.getPropertyValue("--eliza-notif-row-content-visibility") ?? "",
    ).toBe("");

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 88,
      clientX: 12,
      clientY: 20,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 88,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 88,
      clientX: 12,
      clientY: 160,
    });
    act(() => vi.advanceTimersByTime(500));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(
      priorityGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("");
    expect({
      groupOpacity: priorityGroup?.style.opacity,
      groupTransform: priorityGroup?.style.transform,
      surfaceOpacity: prioritySurface?.style.opacity,
      surfaceTransform: prioritySurface?.style.transform,
    }).toEqual(initialMaterial);

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 89,
      clientX: 12,
      clientY: 160,
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(
      priorityGroup?.style.getPropertyValue(
        "--eliza-notif-group-content-visibility",
      ),
    ).toBe("");
    expect({
      groupOpacity: priorityGroup?.style.opacity,
      groupTransform: priorityGroup?.style.transform,
      surfaceOpacity: prioritySurface?.style.opacity,
      surfaceTransform: prioritySurface?.style.transform,
    }).toEqual(initialMaterial);

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 89,
      clientX: 12,
      clientY: 116,
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(true);
    expect(prioritySurface?.style.opacity).toBe("1");
    expect(
      Number.parseFloat(
        priorityGroup?.style.getPropertyValue(
          "--eliza-notif-group-content-visibility",
        ) ?? "0",
      ),
    ).toBeGreaterThan(0);
  });

  it("fades fanned contents without dimming their card material", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "calendar",
        title: "Calendar alert",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "calendar",
        title: "Calendar summary",
      }),
    );
    renderRestedNotifications();
    const priorityRow = screen.getByTestId("notification-row");
    fireEvent.click(priorityRow);
    act(() => vi.advanceTimersByTime(40));
    const controls = screen.getByTestId("notification-stack-controls");
    const quietRow = screen.getByText("Calendar summary").closest("li");
    const stackRows = document.querySelector(
      "[data-notification-stack-rows]",
    ) as HTMLElement;
    const sourceCount = screen.getByTestId("notification-source-count");
    expect(stackRows.style.rowGap).toBe("6px");
    expect(sourceCount.style.opacity).toBe("0");

    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 84,
      clientX: 12,
      clientY: 160,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 84,
      clientX: 12,
      clientY: 116,
    });

    const quietSurface = screen
      .getByText("Calendar summary")
      .closest<HTMLElement>('[data-testid="notification-row-swipe"]');
    const quietContentOpacity = Number.parseFloat(
      quietRow?.style.getPropertyValue(
        "--eliza-notif-row-content-visibility",
      ) ?? "1",
    );
    expect(quietRow?.style.opacity).toBe("1");
    expect(quietSurface?.style.opacity).toBe("1");
    expect(quietContentOpacity).toBeGreaterThan(0);
    expect(quietContentOpacity).toBeLessThan(1);

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 84,
      clientX: 12,
      clientY: 160,
    });
    act(() => vi.advanceTimersByTime(20));
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 84,
      clientX: 12,
      clientY: 160,
    });

    fireEvent.click(document.body);

    expect(screen.getByText("Calendar alert").closest("li")).toBe(
      priorityRow.closest("li"),
    );
    expect(controls.style.opacity).toBe("0");
    expect(controls.style.height).toBe("0px");
    expect(quietRow?.style.opacity).toBe("0");
    expect(quietRow?.style.gridTemplateRows).toBe("0fr");
    expect(stackRows.style.rowGap).toBe("0px");
    expect(sourceCount.style.opacity).toBe("1");
    finishShadeCollapse();
    expect(screen.getByTestId("notification-row")).toBe(priorityRow);
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();
    expect(screen.queryByText("Calendar summary")).toBeNull();
  });

  it("crossfades a fanned priority group back into its resting peek layers", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "high", title: "Old priority" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "high", title: "Middle priority" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Top priority" }),
    );
    renderRestedNotifications();
    const priorityRow = screen.getByTestId("notification-row");
    fireEvent.click(priorityRow);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(3);
    expect(screen.queryByTestId("notification-stack-peek")).toBeNull();

    fireEvent.click(document.body);

    expect(screen.getAllByTestId("notification-row")[0]).toBe(priorityRow);
    const peeks = screen.getAllByTestId("notification-stack-peek");
    expect(peeks).toHaveLength(2);
    expect(peeks[0]?.style.opacity).toBe("0");
    expect(peeks[1]?.style.opacity).toBe("0");
    for (const row of screen.getAllByTestId("notification-row").slice(1)) {
      const container = row.closest("[data-notif-row]") as HTMLElement;
      expect(container.style.opacity).toBe("0");
      expect(container.style.gridTemplateRows).toBe("0fr");
    }
    finishShadeCollapse();
    expect(screen.getByTestId("notification-row")).toBe(priorityRow);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("gestures expand to all priorities and compress back", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // All three priorities are now represented — still stacked (1 top card +
    // 2 tappable peeks); the shade change reveals groups, never flattens them.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    collapseShade();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
    expect(screen.queryByTestId("notifications-count")).toBeNull();
  });

  it("a mouse pull-down past the commit travel expands the shade", () => {
    seedTriage();
    renderRestedNotifications();
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
    expect(list.style.transform).toBe("");
    expect(list.style.transition).toBe("");
    // Stacks persist through the pull; the peeks carry the revealed rows.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    expect(screen.getAllByTestId("notification-stack-peek")).toHaveLength(2);
  });

  it("keeps an owned pull open when preview insertion changes scrollTop", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 109,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 70,
    });
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");

    list.scrollTop = 36;
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 170,
    });
    expect(list.scrollTop).toBe(0);
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 170,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
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
    renderRestedNotifications();
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
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    const revealedGroups = list.querySelectorAll(
      ":scope > [data-notification-pull-reveal]",
    );
    expect(revealedGroups).toHaveLength(2);
    for (const group of revealedGroups) {
      const content = group.querySelector<HTMLElement>(
        "[data-notification-group-content]",
      );
      const opacity = Number.parseFloat(content?.style.opacity ?? "");
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
    }

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 10,
      clientX: 10,
      clientY: 80,
    });
    act(() => vi.advanceTimersByTime(20));
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();
    for (const group of revealedGroups) {
      const content = group.querySelector<HTMLElement>(
        "[data-notification-group-content]",
      );
      const opacity = Number.parseFloat(content?.style.opacity ?? "");
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(1);
    }
  });

  it("keeps resisted overpull on stable shade contents without translating the scroller", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", source: "files" }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 108,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 108,
      clientX: 10,
      clientY: 80,
    });
    // Establish the React drag state before the deep move. Subsequent frames
    // update the runway imperatively, which is the real-browser path that can
    // otherwise leave stale padding behind on release.
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 108,
      clientX: 10,
      clientY: 142,
    });
    act(() => vi.advanceTimersByTime(20));

    const overpull = notificationPullOvershootOffset(dampenPull(132));
    const expectedTransform = `translate3d(0, ${overpull}px, 0)`;
    const groupContent = list.querySelector<HTMLElement>(
      "[data-notification-group-content]",
    );

    expect(list.style.transform).toBe("");
    expect(list.style.getPropertyValue("--eliza-notif-pull-overshoot")).toBe(
      `${overpull}px`,
    );
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");
    expect(list.hasAttribute("data-shade-dragging")).toBe(true);
    expect(groupContent?.style.transform).toBe(expectedTransform);
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();

    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 108,
      clientX: 10,
      clientY: 142,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(list.hasAttribute("data-shade-release-settling")).toBe(true);
    expect(list.style.getPropertyValue("--eliza-notif-pull-overshoot")).toBe(
      "0px",
    );
    act(() => vi.advanceTimersByTime(700));
    expect(list.hasAttribute("data-shade-release-settling")).toBe(false);
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.style.getPropertyValue("--eliza-notif-pull-overshoot")).toBe(
      "0px",
    );
  });

  it("finishes a deep-pull release transaction before an outside close", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");

    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 109,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 170,
    });
    act(() => vi.advanceTimersByTime(20));
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 170,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-release-settling")).toBe(true);
    fireEvent.click(document.body);
    expect(list.hasAttribute("data-shade-release-settling")).toBe(false);
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    expect(list.style.getPropertyValue("--eliza-notif-pull-overshoot")).toBe(
      "0px",
    );
  });

  it("a short pull springs back without toggling", () => {
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "mail",
        title: "Urgent mail",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "files",
        title: "Files updated",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "low",
        source: "agent",
        title: "Agent summary",
      }),
    );
    renderRestedNotifications();
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
    const previewGroups = Array.from(
      list.querySelectorAll<HTMLElement>("[data-notification-pull-reveal]"),
    );
    expect(previewGroups).toHaveLength(3);
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 9,
      clientX: 10,
      clientY: 40,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    const center = screen.getByTestId("home-notification-center");
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      true,
    );
    expect(list.getAttribute("data-shade-preview")).toBe("expanding");
    const shadeCss = center.querySelector("style")?.textContent ?? "";
    const previewRowAnimationGuard = shadeCss.match(
      /\.eliza-notif-scroll \[data-notification-pull-reveal\] \.eliza-notif-row,[^{]+\{([^}]*)\}/,
    )?.[1];
    expect(previewRowAnimationGuard).toContain("animation: none !important");
    expect(
      previewGroups.every((group) => {
        const content = group.querySelector<HTMLElement>(
          "[data-notification-group-content]",
        );
        return (
          group.isConnected &&
          content?.classList.contains("eliza-notif-shade-transition") &&
          content.style.opacity === "0"
        );
      }),
    ).toBe(true);
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(previewGroups.every((group) => group.isConnected)).toBe(true);
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    act(() => vi.advanceTimersByTime(393));
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      true,
    );
    expect(previewGroups.every((group) => group.isConnected)).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );
    const retainedGroups = previewGroups.filter((group) => group.isConnected);
    expect(retainedGroups).toHaveLength(1);
    expect(retainedGroups[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(retainedGroups[0]?.hasAttribute("inert")).toBe(true);
    expect(
      retainedGroups[0]?.querySelector<HTMLElement>(
        "[data-notification-group-content]",
      )?.style.opacity,
    ).toBe("0");
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
  });

  it("keeps the same preview nodes mounted through zero and a committed settle", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", source: "mail" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", source: "files" }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 109,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 80,
    });
    const preview = list.querySelector<HTMLElement>(
      "[data-notification-pull-reveal]",
    );
    expect(preview).toBeTruthy();
    const previewContent = preview?.querySelector<HTMLElement>(
      "[data-notification-group-content]",
    );
    expect(previewContent).toBeTruthy();

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 10,
    });
    act(() => vi.advanceTimersByTime(20));
    expect(list.getAttribute("data-shade-dragging")).not.toBeNull();
    expect(list.querySelector("[data-notification-pull-reveal]")).toBe(preview);
    expect(previewContent?.style.opacity).toBe("0");

    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 80,
    });
    act(() => vi.advanceTimersByTime(20));
    expect(list.querySelector("[data-notification-pull-reveal]")).toBe(preview);
    expect(
      Number.parseFloat(previewContent?.style.opacity ?? "0"),
    ).toBeGreaterThan(0);

    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 109,
      clientX: 10,
      clientY: 80,
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(preview?.isConnected).toBe(true);
    expect(preview?.hasAttribute("data-notification-pull-reveal")).toBe(false);
    expect(previewContent?.style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(460));
    expect(preview?.isConnected).toBe(true);
  });

  it("clears a cancelled-pull settle before a stack opens", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", source: "calendar" }),
    );
    __ingestNotificationForTests(
      makeNotification({ priority: "normal", source: "calendar" }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    fireEvent.pointerDown(list, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 111,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(list, {
      pointerType: "mouse",
      pointerId: 111,
      clientX: 10,
      clientY: 40,
    });
    fireEvent.pointerUp(list, {
      pointerType: "mouse",
      pointerId: 111,
      clientX: 10,
      clientY: 40,
    });
    const center = screen.getByTestId("home-notification-center");
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      true,
    );

    // The list consumes the first post-drag synthetic click. The next click is
    // the intentional activation and must start on its own transition clock.
    fireEvent.click(screen.getByTestId("notification-row"), { detail: 1 });
    fireEvent.click(screen.getByTestId("notification-row"), { detail: 1 });
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notification-stack-controls")).toBeTruthy();
    act(() => vi.advanceTimersByTime(460));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("a touch pull-down expands the shade (native non-passive listener path)", () => {
    seedTriage();
    renderRestedNotifications();
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
    expect(screen.queryByTestId("notifications-count")).toBeNull();
  });

  it("keeps an owned touch pull after preview scroll anchoring", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    fireEvent.touchStart(list, {
      touches: [{ identifier: 7, clientX: 10, clientY: 10 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ identifier: 7, clientX: 10, clientY: 70 }],
    });
    list.scrollTop = 36;
    fireEvent.touchMove(list, {
      touches: [{ identifier: 7, clientX: 10, clientY: 170 }],
    });
    expect(list.scrollTop).toBe(0);
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("retains a native pull when a notification arrives mid-gesture", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(list, {
      touches: [{ identifier: 11, clientX: 10, clientY: 10 }],
    });
    fireEvent.touchMove(list, {
      touches: [{ identifier: 11, clientX: 10, clientY: 70 }],
    });
    __ingestNotificationForTests(
      makeNotification({ priority: "low", source: "live-arrival" }),
    );
    fireEvent.touchMove(list, {
      touches: [{ identifier: 11, clientX: 10, clientY: 170 }],
    });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("keeps a lower-surface mouse pull after the surface scrollTop shifts", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
      </div>,
    );
    collapseShade();
    const surface = screen.getByTestId("home-gesture-surface");
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(surface, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });

    fireEvent.pointerDown(surface, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 12,
      clientX: 180,
      clientY: 300,
    });
    fireEvent.pointerMove(surface, {
      pointerType: "mouse",
      pointerId: 12,
      clientX: 180,
      clientY: 360,
    });
    surface.scrollTop = 36;
    fireEvent.pointerMove(surface, {
      pointerType: "mouse",
      pointerId: 12,
      clientX: 180,
      clientY: 460,
    });
    expect(surface.scrollTop).toBe(0);
    fireEvent.pointerUp(surface, {
      pointerType: "mouse",
      pointerId: 12,
      clientX: 180,
      clientY: 460,
    });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("rebases lower-surface touch travel at the top and retains ownership", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
      </div>,
    );
    collapseShade();
    const surface = screen.getByTestId("home-gesture-surface");
    const list = screen.getByTestId("home-notification-list");
    Object.defineProperty(surface, "scrollTop", {
      configurable: true,
      value: 120,
      writable: true,
    });

    fireEvent.touchStart(surface, {
      touches: [{ identifier: 8, clientX: 180, clientY: 200 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 8, clientX: 180, clientY: 300 }],
    });
    surface.scrollTop = 0;
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 8, clientX: 180, clientY: 400 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 8, clientX: 180, clientY: 430 }],
    });
    fireEvent.touchEnd(surface, { touches: [] });
    expect(list.getAttribute("data-shade-mode")).toBe("rested");

    fireEvent.touchStart(surface, {
      touches: [{ identifier: 9, clientX: 180, clientY: 300 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 9, clientX: 180, clientY: 380 }],
    });
    surface.scrollTop = 24;
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 9, clientX: 180, clientY: 470 }],
    });
    expect(surface.scrollTop).toBe(0);
    fireEvent.touchEnd(surface, { touches: [] });

    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
  });

  it("keeps a deep lower-surface touch pull open through its synthetic release click", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
      </div>,
    );
    collapseShade();
    const surface = screen.getByTestId("home-gesture-surface");
    const list = screen.getByTestId("home-notification-list");

    fireEvent.touchStart(surface, {
      touches: [{ identifier: 14, clientX: 180, clientY: 220 }],
    });
    fireEvent.touchMove(surface, {
      touches: [{ identifier: 14, clientX: 180, clientY: 620 }],
    });
    // A slow hold must not let the release-click guard expire before touchend.
    act(() => vi.advanceTimersByTime(700));
    fireEvent.touchEnd(surface, {
      touches: [],
      changedTouches: [{ identifier: 14, clientX: 180, clientY: 620 }],
    });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(list.hasAttribute("data-shade-release-settling")).toBe(true);
    expect(list.style.getPropertyValue("--eliza-notif-pull-overshoot")).toBe(
      "0px",
    );
    expect(screen.queryByTestId("notifications-collapse-footer")).toBeNull();

    act(() => vi.advanceTimersByTime(700));
    expect(list.hasAttribute("data-shade-release-settling")).toBe(false);

    fireEvent.click(surface, { clientY: 620 });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");

    fireEvent.click(surface, { clientY: 620 });
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
  });

  it("a continuous drag that scrolls the expanded list back to the top does NOT collapse (re-base at the crossing)", () => {
    seedTriage();
    renderRestedNotifications();
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
    __ingestNotificationForTests(
      makeNotification({
        priority: "urgent",
        source: "urgent-source",
        title: "Urgent thing",
      }),
    );
    __ingestNotificationForTests(
      makeNotification({
        priority: "normal",
        source: "normal-source",
        title: "Normal thing",
      }),
    );
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    fireEvent.wheel(list, { deltaY: -(PULL_COMMIT_PX + 10) });
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    const quietGroup = screen
      .getByText("Normal thing")
      .closest("[data-notification-group-content]") as HTMLElement;
    expect(quietGroup.style.opacity).toBe("0");
    expect(quietGroup.style.transform).toContain("-8px");
    act(() => vi.advanceTimersByTime(40));
    expect(quietGroup.style.opacity).toBe("1");
    expect(quietGroup.style.transform).toContain("0px");
  });

  it("the wheel gesture is DIRECTIONAL: trailing same-direction momentum never collapses what it just expanded", () => {
    seedTriage();
    renderRestedNotifications();
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
    renderRestedNotifications();
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
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    finishShadeCollapse();
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryAllByTestId("notification-row")).toHaveLength(1);
  });

  it("a mouse drag UP collapses the expanded shade; drag down while expanded is a no-op", () => {
    seedTriage();
    renderRestedNotifications();
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
    expect(list.style.transform).toBe("");
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("a touch drag UP collapses the expanded shade when the list has no scroll overflow", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    // jsdom geometry: scrollHeight == clientHeight == 0 → no overflow, so the
    // pan-y scroller has nothing to do and the shade owns the upward drag.
    fireEvent.touchStart(list, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 12, clientY: 60 }] });
    fireEvent.touchEnd(list, { touches: [] });
    expect(list.style.transform).toBe("");
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("an upward touch below a short list collapses the expanded shade", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
        data-testid="home-gesture-surface"
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
      </div>,
    );
    const list = expandShade();
    const center = screen.getByTestId("home-notification-center");
    expect(list.className).toContain("flex-1");

    fireEvent.touchStart(center, {
      touches: [{ clientX: 150, clientY: 420 }],
    });
    fireEvent.touchMove(center, {
      touches: [{ clientX: 152, clientY: 280 }],
    });
    fireEvent.touchEnd(center, { touches: [] });

    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("an upward mouse drag on the empty notification region collapses the shade", () => {
    seedTriage();
    renderRestedNotifications();
    const list = expandShade();
    const center = screen.getByTestId("home-notification-center");

    fireEvent.pointerDown(center, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 41,
      clientX: 150,
      clientY: 420,
    });
    fireEvent.pointerMove(center, {
      pointerType: "mouse",
      pointerId: 41,
      clientX: 152,
      clientY: 280,
    });
    fireEvent.pointerUp(center, {
      pointerType: "mouse",
      pointerId: 41,
      clientX: 152,
      clientY: 280,
    });

    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("collapses a fanned shade from empty space below its cards", () => {
    seedTriage();
    renderRestedNotifications();
    const list = expandShade();
    fireEvent.click(screen.getByTestId("notification-row"));
    act(() => vi.advanceTimersByTime(40));
    const center = screen.getByTestId("home-notification-center");
    const group = center.querySelector(
      "[data-notification-group]",
    ) as HTMLElement;
    vi.spyOn(group, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 100,
      top: 100,
      right: 300,
      bottom: 300,
      left: 20,
      width: 280,
      height: 200,
      toJSON: () => ({}),
    });

    fireEvent.click(center, { clientY: 240 });
    expect(list.hasAttribute("data-shade-settling")).toBe(false);
    expect(screen.getByTestId("notification-stack-controls")).toBeTruthy();

    fireEvent.click(center, { clientY: 360 });
    expect(list.hasAttribute("data-shade-settling")).toBe(true);
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(screen.queryByTestId("notification-stack-controls")).toBeNull();
  });

  it("ignores empty-region drags while the shade close is settling", () => {
    seedTriage();
    renderRestedNotifications();
    const list = expandShade();
    const center = screen.getByTestId("home-notification-center");
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.hasAttribute("data-shade-settling")).toBe(true);

    // Neither an aborted nudge nor a commit-distance swipe may start a second
    // transition while the committed close owns the presentation clock.
    fireEvent.pointerDown(center, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 42,
      clientX: 150,
      clientY: 420,
    });
    fireEvent.pointerMove(center, {
      pointerType: "mouse",
      pointerId: 42,
      clientX: 150,
      clientY: 390,
    });
    fireEvent.pointerUp(center, {
      pointerType: "mouse",
      pointerId: 42,
      clientX: 150,
      clientY: 390,
    });
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );

    fireEvent.pointerDown(center, {
      pointerType: "mouse",
      isPrimary: true,
      pointerId: 43,
      clientX: 150,
      clientY: 420,
    });
    fireEvent.pointerMove(center, {
      pointerType: "mouse",
      pointerId: 43,
      clientX: 150,
      clientY: 280,
    });
    fireEvent.pointerUp(center, {
      pointerType: "mouse",
      pointerId: 43,
      clientX: 150,
      clientY: 280,
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );

    act(() => vi.advanceTimersByTime(459));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    act(() => vi.advanceTimersByTime(1));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
  });

  it("ignores empty-region touch swipes while the shade close is settling", () => {
    seedTriage();
    const surfaceRef = { current: null as HTMLElement | null };
    render(
      <div
        ref={(node) => {
          surfaceRef.current = node;
        }}
      >
        <NotificationsHomeCenter emptyGestureTargetRef={surfaceRef} />
      </div>,
    );
    const list = expandShade();
    const center = screen.getByTestId("home-notification-center");
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    fireEvent.wheel(list, { deltaY: PULL_COMMIT_PX + 10 });
    expect(list.hasAttribute("data-shade-settling")).toBe(true);

    fireEvent.touchStart(center, {
      touches: [{ clientX: 150, clientY: 420 }],
    });
    fireEvent.touchMove(center, {
      touches: [{ clientX: 150, clientY: 280 }],
    });
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
    fireEvent.touchEnd(center, { touches: [] });
    expect(center.hasAttribute("data-notification-shade-cancelling")).toBe(
      false,
    );

    act(() => vi.advanceTimersByTime(459));
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    act(() => vi.advanceTimersByTime(1));
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
    expect(list.hasAttribute("data-shade-dragging")).toBe(false);
  });

  it("a bottom-edge touch drag closes an overflowing expanded shade", () => {
    seedTriage();
    renderRestedNotifications();
    const list = screen.getByTestId("home-notification-list");
    expandShade();
    setOverflowingListGeometry(list);

    fireEvent.touchStart(list, { touches: [{ clientX: 150, clientY: 470 }] });
    fireEvent.touchMove(list, { touches: [{ clientX: 152, clientY: 330 }] });
    fireEvent.touchEnd(list, { touches: [] });

    expect(list.style.transform).toBe("");
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("an upward touch in the middle of overflowing content scrolls instead of collapsing", () => {
    seedTriage();
    renderRestedNotifications();
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
    renderRestedNotifications();
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

    expect(list.style.transform).toBe("");
    finishShadeCollapse();
    expect(list.getAttribute("data-shade-mode")).toBe("rested");
  });

  it("a touch drag DOWN while expanded never collapses (directional, not a toggle)", () => {
    seedTriage();
    renderRestedNotifications();
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
    renderRestedNotifications();
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

  it("a single notification shows by default without a total control", () => {
    __ingestNotificationForTests(
      makeNotification({ priority: "urgent", title: "Only one" }),
    );
    render(<NotificationsHomeCenter />);
    expect(screen.queryByTestId("notifications-pull-hint")).toBeNull();
    expect(screen.queryByTestId("notifications-expand-toggle")).toBeNull();
    expect(screen.queryByTestId("notifications-count")).toBeNull();
    const list = screen.getByTestId("home-notification-list");
    expect(list.getAttribute("data-shade-mode")).toBe("expanded");
    expect(screen.getByTestId("notification-row")).toBeTruthy();
    expect(screen.queryByTestId("notifications-collapse")).toBeNull();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    const li = screen.getByText("Swipe away").closest("li") as HTMLElement;
    const swipe = li.querySelector(
      '[data-testid="notification-row-swipe"]',
    ) as HTMLElement;
    const button = li.querySelector(
      '[data-testid="notification-row"]',
    ) as HTMLElement;
    expect(swipe.style.willChange).toBe("");
    // Drag left well past SWIPE_DISMISS_PX (88): down at 120, move to 10 (dx=-110
    // → axis locks x, past threshold), release → commitDismiss(left).
    pointer(swipe, "pointerDown", { x: 120, y: 20 });
    pointer(swipe, "pointerMove", { x: 60, y: 22 });
    expect(swipe.style.willChange).toBe("transform, opacity");
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
      renderRestedNotifications();
      expandShade();
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
    renderRestedNotifications();
    expandShade();
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
    renderRestedNotifications();
    expandShade();
    // The ContinuousChatOverlay outside-tap collapse-swallower exempts anything
    // under [data-testid="home-notification-center"] or [data-notif-row]; both
    // must be present or a row tap gets eaten (the r8 "cooked" bug).
    expect(screen.getByTestId("home-notification-center")).toBeTruthy();
    const row = screen.getByText("Exempt").closest("li") as HTMLElement;
    expect(row.hasAttribute("data-notif-row")).toBe(true);
  });
});
