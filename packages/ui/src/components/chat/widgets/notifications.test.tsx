// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { __resetNotificationStoreForTests } from "../../../state/notifications/notification-store";
import { NotificationsWidget } from "./notifications";

afterEach(() => {
  cleanup();
  __resetNotificationStoreForTests();
});

// #9143 — the frontpage Notifications widget renders from the shared store.
// #9226 — with no notifications it renders nothing (no empty placeholder card)
// so the Springboard home isn't cluttered with dead slots.
describe("NotificationsWidget (#9143)", () => {
  it("renders nothing when there are no notifications (#9226)", () => {
    __resetNotificationStoreForTests();
    const { container } = render(
      <NotificationsWidget pluginId="notifications" />,
    );
    expect(screen.queryByTestId("widget-notifications")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
