// @vitest-environment jsdom

/**
 * Render-count lock for elizaOS/eliza issue #14559 - the `useNow(60s)`
 * full-inbox re-render fix (binding pattern, spec §C.4).
 *
 * BEFORE: `NotificationsHomeCenter` called `useNow(60_000)` at the component
 * top, so every minute the entire inbox (up to 100 rows, each with buttons,
 * over a `backdrop-blur` glass surface) re-rendered just to refresh "5m ago"
 * strings; `NotificationRow` was intentionally un-memoized to keep those
 * strings live.
 *
 * AFTER: the relative timestamp lives in a `<RelativeTime>` LEAF that owns the
 * shared, visibility-gated ticker. The minute tick re-renders ONLY the `<time>`
 * text nodes; the rows (now `React.memo`'d) and the list container do not
 * re-render. This test proves exactly that with real React commit counts
 * (`RenderProbe`/`useRenderSpy`) - re-introducing a list-level `useNow`, or
 * un-memoizing the row, makes the "rows do not re-render on tick" assertion go
 * red.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink: vi.fn(),
}));

import type { AgentNotification, NotificationCategory } from "@elizaos/core";
import { __resetSharedNowForTests, MINUTE_MS } from "../../hooks/useSharedNow";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import {
  __setNotificationRowRenderObserverForTests,
  __setNotificationsHomeCenterRenderObserverForTests,
  NotificationsHomeCenter,
  rowPropsEqual,
} from "./NotificationsHomeCenter";

// Distinct categories per fixture row: same-category interrupt rows collapse
// into a rested Z-stack (one interactive card), and these render-count tests
// need every row painted flat.
const CATEGORY_SPREAD: NotificationCategory[] = [
  "general",
  "system",
  "task",
  "reminder",
  "workflow",
  "approval",
  "message",
  "health",
];

let seq = 0;
function makeNotification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  seq += 1;
  const hex = String(seq).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}` as AgentNotification["id"],
    title: `Notification ${seq}`,
    category: CATEGORY_SPREAD[seq % CATEGORY_SPREAD.length] ?? "general",
    // High so fixtures render in the rested (interrupt-only) shade.
    priority: "high",
    source: "test",
    // Spread across the last hour so the rows render distinct "Nm ago" strings
    // that actually change as the clock advances (a real relative-time surface).
    createdAt: Date.now() - seq * 5 * MINUTE_MS,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-25T14:30:00Z"));
});

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  __resetSharedNowForTests();
  __setNotificationRowRenderObserverForTests(null);
  __setNotificationsHomeCenterRenderObserverForTests(null);
  vi.useRealTimers();
});

describe("NotificationsHomeCenter render count (#14559)", () => {
  it("the minute tick re-renders only RelativeTime leaves, not the list container", () => {
    for (let i = 0; i < 8; i++) {
      __ingestNotificationForTests(makeNotification());
    }

    let listRenders = 0;
    __setNotificationsHomeCenterRenderObserverForTests(() => {
      listRenders += 1;
    });

    render(<NotificationsHomeCenter />);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    expect(listRenders).toBe(1);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(8);
    const times = () =>
      screen
        .getAllByTestId("notification-row-time")
        .map((el) => el.textContent);
    const before = times();

    listRenders = 0;
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });

    const after = times();
    // The relative strings advanced by ~1 minute (leaves re-rendered).
    expect(after).not.toEqual(before);
    // But the list component body did not execute, so no re-slice/re-sort and
    // no remapping up to 100 rows. Re-introducing list-level `useNow(60s)` makes
    // this count jump to 1 on the minute tick.
    expect(listRenders).toBe(0);
    expect(screen.getAllByTestId("notification-row")).toHaveLength(8);
  });

  it("rows are memoized: minute tick re-renders zero NotificationRow bodies", () => {
    for (let i = 0; i < 30; i++) {
      __ingestNotificationForTests(makeNotification({ title: `Row ${i}` }));
    }

    let rowRenders = 0;
    __setNotificationRowRenderObserverForTests(() => {
      rowRenders += 1;
    });

    render(<NotificationsHomeCenter />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Fan the shade AND the group's stack out so all 30 rows paint flat
    // (stacks persist through the shade toggle now).
    fireEvent.click(screen.getByTestId("notifications-expand-toggle"));
    for (const label of screen.getAllByTestId("notification-group-label")) {
      if (!(label as HTMLButtonElement).disabled) fireEvent.click(label);
    }
    expect(screen.getAllByTestId("notification-row")).toHaveLength(30);
    expect(rowRenders).toBeGreaterThanOrEqual(30);

    const timeBefore = screen.getAllByTestId("notification-row-time")[0]
      .textContent;
    rowRenders = 0;
    act(() => {
      vi.advanceTimersByTime(MINUTE_MS);
    });

    // This is the failing-when-broken proof for #14559: the minute roll updates
    // the leaf time text, but it does NOT execute any NotificationRow render
    // body. Re-introducing list-level `useNow(60s)` or removing React.memo makes
    // this count jump to the rendered row count.
    expect(rowRenders).toBe(0);
    expect(
      screen.getAllByTestId("notification-row-time")[0].textContent,
    ).not.toBe(timeBefore);
  });

  it("rowPropsEqual: skips re-render on a createdAt-only change, re-renders on identity change", () => {
    // The memo's equality function is the surgical part of the fix: `createdAt`
    // is excluded (it feeds only the leaf), so the once-a-minute newer-timestamp
    // never re-renders the row; but any field that changes the row's OWN markup
    // (title, body, deepLink, data.count, the single-open expanded flag) does.
    // Read state and priority no longer style the row (platform-shade model),
    // so they are not compared.
    const base = makeNotification({
      title: "T",
      body: "B",
      priority: "normal",
      readAt: null,
      deepLink: "/x",
    });
    const onOpen = () => {};
    const onDismiss = () => {};
    const onPrefill = () => {};
    const onToggleExpand = () => {};
    const props = {
      notification: base,
      expanded: false,
      onToggleExpand,
      onOpen,
      onDismiss,
      onPrefill,
    };

    // createdAt-only delta → equal → memo SKIPS (no row re-render on the minute).
    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, createdAt: base.createdAt + MINUTE_MS },
      }),
    ).toBe(true);

    // A readAt / priority delta no longer changes the row's markup → equal.
    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, readAt: Date.now() },
      }),
    ).toBe(true);
    // Each identity field flips it to a real re-render.
    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, title: "T2" },
      }),
    ).toBe(false);
    expect(
      rowPropsEqual(props, {
        ...props,
        notification: { ...base, body: "B2" },
      }),
    ).toBe(false);
    // The single-open strip flag re-renders exactly the two affected rows.
    expect(rowPropsEqual(props, { ...props, expanded: true })).toBe(false);
    // A new callback identity (parent lost its useCallback) also re-renders.
    expect(rowPropsEqual(props, { ...props, onOpen: () => {} })).toBe(false);
    expect(rowPropsEqual(props, { ...props, onToggleExpand: () => {} })).toBe(
      false,
    );
  });

  it("rows still show live relative times (no 'just now' pin regression)", () => {
    // The old comment warned a stable-props memo would "pin just now forever".
    // With the leaf pattern that risk is gone: the row is memoized on identity
    // fields but the time still advances because it lives in the leaf.
    __ingestNotificationForTests(
      makeNotification({ title: "Fresh", createdAt: Date.now() }),
    );
    render(<NotificationsHomeCenter />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByTestId("notification-row-time").textContent).toBe("now");

    // 3 minutes later the SAME row (memoized) shows "3m" - not pinned.
    act(() => {
      vi.advanceTimersByTime(3 * MINUTE_MS);
    });
    expect(screen.getByTestId("notification-row-time").textContent).toBe("3m");
  });

  it("tap clears the top of a stack without reordering the survivors (stable-order invariant)", () => {
    const urgent = makeNotification({
      priority: "urgent",
      title: "First",
      category: "general",
    });
    __ingestNotificationForTests(
      makeNotification({ title: "Second", category: "general" }),
    );
    __ingestNotificationForTests(urgent);
    render(<NotificationsHomeCenter />);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    const titles = () =>
      screen
        .getAllByTestId("notification-row")
        .map((el) => el.textContent ?? "");
    // Same view-group: the rested shade stacks them, highest priority on top.
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("First");
    // Platform-shade acknowledgement: tap expands, acting clears; the next
    // card in the stack surfaces without any reshuffle.
    fireEvent.click(screen.getAllByTestId("notification-row")[0]);
    fireEvent.click(screen.getByTestId("notification-option-dismiss"));
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("Second");
  });
});
