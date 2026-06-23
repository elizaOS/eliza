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
describe("NotificationsWidget (#9143)", () => {
  it("renders its empty state when there are no notifications", () => {
    __resetNotificationStoreForTests();
    render(<NotificationsWidget pluginId="notifications" />);
    expect(screen.getByTestId("widget-notifications")).toBeTruthy();
    expect(screen.getByText("No notifications yet")).toBeTruthy();
  });
});
