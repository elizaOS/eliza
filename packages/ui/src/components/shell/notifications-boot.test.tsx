// @vitest-environment jsdom

/**
 * Verifies the split notification data/shell boot boundaries and the global
 * open-center event against the real browser event lifecycle.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  goHome: vi.fn(),
  init: vi.fn(),
  push: vi.fn(async () => undefined),
  setTab: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: { setTab: typeof mocks.setTab }) => unknown,
  ) => selector({ setTab: mocks.setTab }),
}));
vi.mock("../../state/notifications/notification-store", () => ({
  initNotifications: mocks.init,
}));
vi.mock("../../state/notifications/push-registration", () => ({
  initPushRegistration: mocks.push,
}));
vi.mock("../../state/shell-surface-store", () => ({ goHome: mocks.goHome }));

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

  it("boots native push and removes notification-center routing on unmount", async () => {
    const rendered = render(<NotificationsShellBoot />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT)));
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
    expect(mocks.goHome).toHaveBeenCalledOnce();

    rendered.unmount();
    window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT));
    expect(mocks.goHome).toHaveBeenCalledOnce();
  });
});
