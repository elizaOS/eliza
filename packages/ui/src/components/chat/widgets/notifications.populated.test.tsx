// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../../state/notifications/notification-store";
import { NotificationsWidget } from "./notifications";

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
});

interface NotificationOverrides {
  priority?: AgentNotification["priority"];
  body?: string;
  createdAt?: number;
  readAt?: number | null;
}

/** A fully-typed `AgentNotification` fixture; overrides drive ranking/badge. */
function notification(
  id: string,
  title: string,
  overrides: NotificationOverrides = {},
): AgentNotification {
  return {
    id,
    title,
    category: "general",
    priority: overrides.priority ?? "normal",
    source: "test",
    createdAt: overrides.createdAt ?? 1_000,
    readAt: overrides.readAt ?? null,
    ...(overrides.body !== undefined ? { body: overrides.body } : {}),
  };
}

function renderWidget() {
  return render(<NotificationsWidget pluginId="notifications" />);
}

function rowTitles(): string[] {
  // Each row is a <li><button …>; the title is the first text node inside it
  // (an aria-hidden icon chip + optional unread dot carry no text, and the
  // timestamp <time> is right-aligned after the title/body column).
  return screen
    .getAllByRole("listitem")
    .map((li) => within(li).getAllByText(/.+/)[0].textContent ?? "");
}

// #9143/#9304 — the populated branch of the frontpage Notifications widget.
// notifications.test.tsx covers only the empty return-null branch; this asserts
// real rendered behaviour: rankHomeNotifications ordering (unread → priority →
// recency), the unread-count badge threshold, and conditional body rendering.
describe("NotificationsWidget — populated (#9304)", () => {
  it("orders rows unread-first, then by priority, then recency", () => {
    __resetNotificationStoreForTests();
    // Ingested oldest-to-newest; the store keeps them newest-first, then the
    // widget re-ranks by attention.
    __ingestNotificationForTests(
      notification("read-urgent", "Read urgent", {
        priority: "urgent",
        createdAt: 5_000,
        readAt: 9_000,
      }),
    );
    __ingestNotificationForTests(
      notification("unread-normal-old", "Unread normal old", {
        priority: "normal",
        createdAt: 1_000,
      }),
    );
    __ingestNotificationForTests(
      notification("unread-high", "Unread high", {
        priority: "high",
        createdAt: 2_000,
      }),
    );
    __ingestNotificationForTests(
      notification("unread-normal-new", "Unread normal new", {
        priority: "normal",
        createdAt: 4_000,
      }),
    );

    renderWidget();

    // Unread before the read item; among unread, high outranks normal; among
    // equal-priority unread, newer createdAt wins.
    expect(rowTitles()).toEqual([
      "Unread high",
      "Unread normal new",
      "Unread normal old",
      "Read urgent",
    ]);
  });

  it("caps the list at the top 4 ranked notifications", () => {
    __resetNotificationStoreForTests();
    for (let i = 1; i <= 6; i++) {
      __ingestNotificationForTests(
        notification(`n${i}`, `Note ${i}`, { createdAt: i * 1_000 }),
      );
    }

    renderWidget();

    // All unread + equal priority → ranked by recency (newest createdAt first).
    expect(rowTitles()).toEqual(["Note 6", "Note 5", "Note 4", "Note 3"]);
    expect(screen.queryByText("Note 2")).toBeNull();
    expect(screen.queryByText("Note 1")).toBeNull();
  });

  it("shows the unread-count badge only while there are unread notifications", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification("a", "First", { createdAt: 2_000 }),
    );
    __ingestNotificationForTests(
      notification("b", "Second", { createdAt: 1_000 }),
    );

    const { rerender } = renderWidget();
    const section = screen.getByTestId("widget-notifications");
    expect(within(section).getByText("2").textContent).toBe("2");

    // Mark both read (store recomputes unreadCount → 0) and the badge drops.
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification("a", "First", { createdAt: 2_000, readAt: 3_000 }),
    );
    __ingestNotificationForTests(
      notification("b", "Second", { createdAt: 1_000, readAt: 3_000 }),
    );
    rerender(<NotificationsWidget pluginId="notifications" />);

    const refreshed = screen.getByTestId("widget-notifications");
    expect(within(refreshed).queryByText("2")).toBeNull();
    expect(within(refreshed).queryByText("0")).toBeNull();
  });

  it("renders the body line only when a body is present", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification("with-body", "Has body", {
        body: "Detail line",
        createdAt: 2_000,
      }),
    );
    __ingestNotificationForTests(
      notification("no-body", "No body", { createdAt: 1_000 }),
    );

    renderWidget();

    expect(screen.getByText("Detail line").textContent).toBe("Detail line");
    // The with-body row shows both its title and its body line.
    const withBodyRow = within(screen.getByTestId("widget-notifications"))
      .getByText("Has body")
      .closest("li");
    expect(withBodyRow).not.toBeNull();
    expect(
      within(withBodyRow as HTMLElement).queryByText("Detail line"),
    ).not.toBeNull();

    // The no-body row renders its title but no body line at all.
    const noBodyRow = within(screen.getByTestId("widget-notifications"))
      .getByText("No body")
      .closest("li");
    expect(noBodyRow).not.toBeNull();
    expect(
      within(noBodyRow as HTMLElement).queryByText("Detail line"),
    ).toBeNull();
  });
});
