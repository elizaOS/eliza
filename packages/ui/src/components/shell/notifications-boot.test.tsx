/** Verifies notification boot boundaries through the package's configured test harness. */
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  push: vi.fn(async () => undefined),
  seed: vi.fn(async () => undefined),
  setTab: vi.fn(),
}));

vi.mock("../../state", () => ({ useAppSelector: () => mocks.setTab }));
vi.mock("../../state/notifications/notification-store", () => ({
  initNotifications: mocks.init,
  seedDevNotificationsIfEmpty: mocks.seed,
}));
vi.mock("../../state/notifications/push-registration", () => ({
  initPushRegistration: mocks.push,
}));

import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";
import {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./notifications-boot";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("notification boot boundaries", () => {
  it("starts WebSocket ingress from the headless data boot", () => {
    const { container } = render(<NotificationsDataBoot />);
    expect(container.innerHTML).toBe("");
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it("boots native push and routes notification-center ingress to chat", async () => {
    render(<NotificationsShellBoot />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT)));
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
  });
});
