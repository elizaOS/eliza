// @vitest-environment jsdom
/**
 * NotificationBanners: the top-of-screen glass banner queue. Drives the real
 * banner store; navigate + mark-read are mocked so tap-through and auto-dismiss
 * are asserted without a server.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigateDeepLink = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/navigate-deep-link", async (orig) => ({
  ...(await orig()),
  navigateDeepLink,
}));

const markNotificationRead = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/notification-store", () => ({
  markNotificationRead: (...a: unknown[]) => markNotificationRead(...a),
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __resetNotificationBannersForTests,
  pushNotificationBanner,
} from "../../state/notifications/notification-banner-store";
import { NotificationBanners } from "./NotificationBanners";

function makeNotification(
  o: Partial<AgentNotification> = {},
): AgentNotification {
  return {
    id: o.id ?? "b-1",
    title: o.title ?? "Deploy done",
    body: o.body,
    category: o.category ?? "system",
    priority: o.priority ?? "normal",
    source: o.source ?? "agent",
    deepLink: o.deepLink,
    createdAt: o.createdAt ?? Date.now(),
    readAt: o.readAt ?? null,
  };
}

afterEach(() => {
  cleanup();
  __resetNotificationBannersForTests();
  navigateDeepLink.mockReset();
  markNotificationRead.mockReset();
  vi.useRealTimers();
});

describe("NotificationBanners", () => {
  it("renders nothing while the queue is empty", () => {
    render(<NotificationBanners />);
    expect(screen.queryByTestId("notification-banners")).toBeNull();
  });

  it("renders an arriving notification as a glass banner card", () => {
    render(<NotificationBanners />);
    act(() => pushNotificationBanner(makeNotification({ body: "Build #42" })));
    const card = screen.getByTestId("notification-banner");
    expect(card.textContent).toContain("Deploy done");
    // Glass look: translucent surface + hairline border + blur on the card body.
    const surface = card.parentElement;
    expect(surface?.className).toMatch(/backdrop-blur/);
    expect(surface?.className).toMatch(/border/);
  });

  it("carries an urgent accent rail", () => {
    render(<NotificationBanners />);
    act(() => pushNotificationBanner(makeNotification({ priority: "urgent" })));
    expect(screen.getByTestId("notification-banner-accent")).toBeTruthy();
  });

  it("tapping marks read, follows a safe deep link, and dismisses the banner", () => {
    render(<NotificationBanners />);
    act(() =>
      pushNotificationBanner(makeNotification({ deepLink: "/settings" })),
    );
    fireEvent.click(screen.getByTestId("notification-banner"));
    expect(markNotificationRead).toHaveBeenCalledWith("b-1");
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
    expect(screen.queryByTestId("notification-banner")).toBeNull();
  });

  it("the X dismisses the banner without marking it read", () => {
    render(<NotificationBanners />);
    act(() => pushNotificationBanner(makeNotification()));
    fireEvent.click(screen.getByTestId("notification-banner-dismiss"));
    expect(screen.queryByTestId("notification-banner")).toBeNull();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("auto-dismisses after the priority-scaled dwell", () => {
    vi.useFakeTimers();
    render(<NotificationBanners />);
    act(() => pushNotificationBanner(makeNotification({ priority: "normal" })));
    expect(screen.getByTestId("notification-banner")).toBeTruthy();
    // Normal dwell is 4000ms; advance past it.
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByTestId("notification-banner")).toBeNull();
  });
});
