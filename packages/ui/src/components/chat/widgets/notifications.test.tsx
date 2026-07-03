// @vitest-environment jsdom
import type { AgentNotification } from "@elizaos/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../../state/notifications/notification-store";
import { NotificationsWidget } from "./notifications";

// useWidgetNavigation → reportUserViewSwitch (slash-command controller); stub it
// so the home-card click test isolates the navigation rail (the CustomEvent).
vi.mock("../../../chat/useSlashCommandController", () => ({
  reportUserViewSwitch: vi.fn(),
}));

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
});

let idCounter = 0;
function notification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  idCounter += 1;
  return {
    id: `00000000-0000-0000-0000-00000000000${idCounter}` as AgentNotification["id"],
    title: "A notification",
    category: "general",
    priority: "normal",
    source: "test",
    createdAt: Date.now(),
    ...overrides,
  };
}

// #9143 — the frontpage Notifications widget renders from the shared store.
// #9226 — with no notifications it renders nothing (no empty placeholder card)
// so the Launcher home isn't cluttered with dead slots.
describe("NotificationsWidget (#9143)", () => {
  it("renders nothing when there are no notifications (#9226)", () => {
    __resetNotificationStoreForTests();
    const { container } = render(
      <NotificationsWidget pluginId="notifications" />,
    );
    expect(screen.queryByTestId("widget-notifications")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("home slot: ONE compact, icon-first card — top notification + unread badge, whole card clickable", () => {
    __resetNotificationStoreForTests();
    // Older normal + newer urgent: the urgent (highest-priority, unread) wins.
    __ingestNotificationForTests(
      notification({ title: "Routine ping", priority: "normal" }),
    );
    __ingestNotificationForTests(
      notification({ title: "Disk almost full", priority: "urgent" }),
      2,
    );

    render(<NotificationsWidget pluginId="notifications" slot="home" />);

    const card = screen.getByTestId("widget-notifications");
    // Whole card is a button; the single datum is the top notification's title,
    // not the full list (the second notification is not rendered as a row).
    expect(card.tagName).toBe("BUTTON");
    expect(card.textContent).toContain("Disk almost full");
    expect(card.textContent).toContain("2");
    // The full meaning lives in the aria-label since visible text is minimal.
    expect(card.getAttribute("aria-label")).toMatch(/2 unread/i);
    expect(card.getAttribute("aria-label")).toMatch(/Disk almost full/);
  });

  it("home slot: clicking the card navigates to the inbox (or the deep link)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(notification({ title: "Plain alert" }), 1);

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<NotificationsWidget pluginId="notifications" slot="home" />);
    fireEvent.click(screen.getByTestId("widget-notifications"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/inbox");
  });

  it("home slot: prefers the notification's own deep link when present", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification({ title: "Review needed", deepLink: "/tasks" }),
      1,
    );

    const navEvents: string[] = [];
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ viewPath?: string }>).detail;
      if (detail?.viewPath) navEvents.push(detail.viewPath);
    };
    window.addEventListener("eliza:navigate:view", onNav);

    render(<NotificationsWidget pluginId="notifications" slot="home" />);
    fireEvent.click(screen.getByTestId("widget-notifications"));
    window.removeEventListener("eliza:navigate:view", onNav);

    expect(navEvents).toContain("/tasks");
  });

  it("chat-sidebar slot: keeps the existing list (a row per notification, not a single card button)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(notification({ title: "First" }));
    __ingestNotificationForTests(notification({ title: "Second" }), 2);

    render(
      <NotificationsWidget pluginId="notifications" slot="chat-sidebar" />,
    );

    const widget = screen.getByTestId("widget-notifications");
    // The sidebar renders the WidgetSection list (not a button card): both
    // notifications appear as rows.
    expect(widget.tagName).not.toBe("BUTTON");
    expect(widget.textContent).toContain("First");
    expect(widget.textContent).toContain("Second");
  });

  it("chat-sidebar slot: every row shows a per-category icon from the shared map (#10697)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification({ title: "Ping", category: "message" }),
    );
    __ingestNotificationForTests(
      notification({ title: "Due", category: "reminder" }),
      2,
    );

    render(
      <NotificationsWidget pluginId="notifications" slot="chat-sidebar" />,
    );

    const icons = screen.getAllByTestId("notification-row-icon");
    expect(icons).toHaveLength(2);
    // Each icon slot renders a real (lucide svg) glyph, not an empty node.
    for (const icon of icons) {
      expect(icon.querySelector("svg")).toBeTruthy();
    }
  });

  it("home slot: the tile leads with the top notification's category icon (#10697)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification({
        title: "New message",
        category: "message",
        priority: "high",
      }),
      1,
    );

    render(<NotificationsWidget pluginId="notifications" slot="home" />);
    const card = screen.getByTestId("widget-notifications");
    // The card renders an icon glyph (the category icon now, not a hard-coded bell).
    expect(card.querySelector("svg")).toBeTruthy();
  });

  it("home slot: applies the host-supplied spanClassName to its single root grid-item element (#11752)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification({ title: "Disk almost full", priority: "urgent" }),
    );

    const { container } = render(
      <NotificationsWidget
        pluginId="notifications"
        slot="home"
        spanClassName="col-span-2 row-span-1"
      />,
    );

    const root = container.firstElementChild;
    expect(root).not.toBeNull();
    expect(root?.className).toContain("col-span-2");
    expect(root?.className).toContain("row-span-1");
    expect(
      root?.querySelector('[data-testid="widget-notifications"]'),
    ).not.toBeNull();
  });

  it("home slot: falls back to the default 2x1 span when no spanClassName is supplied (#11752)", () => {
    __resetNotificationStoreForTests();
    __ingestNotificationForTests(
      notification({ title: "Disk almost full", priority: "urgent" }),
    );

    const { container } = render(
      <NotificationsWidget pluginId="notifications" slot="home" />,
    );
    expect(container.firstElementChild?.className).toContain("col-span-2");
  });
});
