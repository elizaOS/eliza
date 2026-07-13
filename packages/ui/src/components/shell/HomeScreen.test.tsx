// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateDeepLink = vi.hoisted(() => vi.fn());
vi.mock("../../state/notifications/navigate-deep-link", async (original) => ({
  ...(await original()),
  navigateDeepLink,
}));

vi.mock("../../hooks/useActivityEvents", () => ({
  useActivityEvents: () => ({ events: [], clearEvents: vi.fn() }),
}));

vi.mock("../../widgets/WidgetHost", () => ({
  WidgetHost: (props: { slot: string }) => (
    <div data-testid="home-widget-host" data-slot={props.slot} />
  ),
}));

import type { AgentNotification } from "@elizaos/core";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../state/notifications/notification-store";
import { __resetHomeDismissalsForTests } from "../../widgets/home-dismissal-store";
import { HomeScreen } from "./HomeScreen";
import { NOTIFICATION_LIST_MAX_HEIGHT } from "./NotificationsHomeCenter";

let sequence = 0;
function notification(
  overrides: Partial<AgentNotification> = {},
): AgentNotification {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}` as AgentNotification["id"],
    title: `Notification ${sequence}`,
    category: "task",
    priority: "high",
    source: `source-${sequence}`,
    createdAt: Date.now() - sequence * 1000,
    readAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  sequence = 0;
});

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
  __resetHomeDismissalsForTests();
  navigateDeepLink.mockClear();
});

const NATIVE_OS_TILES = ["messages", "phone", "contacts", "camera"];

function tileIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid^="home-tile-"]'),
  ).map((element) =>
    (element.getAttribute("data-testid") ?? "").replace("home-tile-", ""),
  );
}

describe("HomeScreen", () => {
  it("mounts the home WidgetHost and keeps general apps out of the AOSP strip", () => {
    const { container } = render(<HomeScreen onOpenTile={vi.fn()} />);
    expect(
      screen.getByTestId("home-widget-host").getAttribute("data-slot"),
    ).toBe("home");
    expect(tileIds(container)).toEqual([]);
    expect(screen.queryByTestId("home-tiles")).toBeNull();
  });

  it("shows exactly the native OS tiles on the AOSP fork", () => {
    const { container } = render(
      <HomeScreen onOpenTile={vi.fn()} showNativeOsTiles />,
    );
    expect(tileIds(container)).toEqual(NATIVE_OS_TILES);
  });

  it("opens a native tile with its existing target", () => {
    const onOpenTile = vi.fn();
    render(<HomeScreen onOpenTile={onOpenTile} showNativeOsTiles />);
    fireEvent.click(screen.getByTestId("home-tile-camera"));
    expect(onOpenTile).toHaveBeenCalledWith({ kind: "tab", tab: "camera" });
  });

  it("renders no notification spacer before hydration or for a hydrated empty inbox", () => {
    const { rerender } = render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<div data-testid="curated-app-grid">Apps</div>}
      />,
    );
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    expect(screen.getByTestId("home-apps-section")).toBeTruthy();

    __setHydratedForTests(true);
    rerender(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<div data-testid="curated-app-grid">Apps</div>}
      />,
    );
    expect(screen.queryByTestId("home-notification-center")).toBeNull();
    expect(screen.getByTestId("home-apps-section")).toBeTruthy();
  });

  it("stacks Apps directly below a natural-height bounded notification center", () => {
    __ingestNotificationForTests(
      notification({ title: "Priority", priority: "urgent" }),
    );
    __ingestNotificationForTests(
      notification({ title: "Quiet", priority: "normal" }),
    );
    render(
      <HomeScreen
        onOpenTile={vi.fn()}
        apps={<div data-testid="curated-app-grid">All views</div>}
      />,
    );

    const center = screen.getByTestId("home-notification-center");
    const wrapper = center.parentElement as HTMLElement;
    const apps = screen.getByTestId("home-apps-section");
    const list = screen.getByTestId("home-notification-list");
    expect(wrapper.className).toContain("mt-4");
    expect(wrapper.className).not.toContain("flex-1");
    expect(center.className).not.toContain("flex-1");
    expect(list.style.maxHeight).toBe(NOTIFICATION_LIST_MAX_HEIGHT);
    expect(
      wrapper.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    expect(screen.getByTestId("curated-app-grid")).toBeTruthy();

    // Expansion adds the quiet row in the normal-flow block; Apps remains the
    // immediate following product section and therefore moves with its height.
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(2);
    expect(
      wrapper.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("notifications-mode-toggle"));
    expect(screen.getAllByTestId("notification-row")).toHaveLength(1);
  });

  it("keeps the unified home column vertically scrollable without cross-axis pan", () => {
    render(<HomeScreen onOpenTile={vi.fn()} />);
    const home = screen.getByTestId("home-screen");
    const column = screen.getByTestId("home-content-column");
    expect(home.className).toContain("touch-pan-y");
    expect(home.className).toContain("overflow-y-auto");
    expect(home.className).toContain("overflow-x-hidden");
    expect(column.className).toContain("min-h-full");
    expect(column.className).not.toMatch(/(^|\s)h-full(\s|$)/);
  });

  it("opens a flat notification through its safe deep link", () => {
    __ingestNotificationForTests(
      notification({ title: "Open Settings", deepLink: "/settings" }),
    );
    render(<HomeScreen onOpenTile={vi.fn()} />);
    fireEvent.click(screen.getByTestId("notification-row"));
    expect(navigateDeepLink).toHaveBeenCalledWith("/settings");
  });
});
