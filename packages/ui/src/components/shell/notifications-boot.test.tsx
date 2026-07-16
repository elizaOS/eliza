// @vitest-environment jsdom

/**
 * Verifies the headless notification boot boundary and its global open-center
 * event using mocked store/native sinks and the real browser event lifecycle.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";

const mocks = vi.hoisted(() => ({
  goHome: vi.fn(),
  initNotifications: vi.fn(),
  initPushRegistration: vi.fn(async () => {}),
  setTab: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: { setTab: typeof mocks.setTab }) => unknown,
  ) => selector({ setTab: mocks.setTab }),
}));

vi.mock("../../state/notifications/notification-store", () => ({
  initNotifications: mocks.initNotifications,
}));

vi.mock("../../state/notifications/push-registration", () => ({
  initPushRegistration: mocks.initPushRegistration,
}));

vi.mock("../../state/shell-surface-store", () => ({
  goHome: mocks.goHome,
}));

import { NotificationsShellBoot } from "./notifications-boot";

describe("NotificationsShellBoot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("boots notification delivery once and routes open-center events home", () => {
    const rendered = render(<NotificationsShellBoot />);

    expect(mocks.initNotifications).toHaveBeenCalledOnce();
    expect(mocks.initPushRegistration).toHaveBeenCalledOnce();

    act(() => {
      window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT));
    });
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
    expect(mocks.goHome).toHaveBeenCalledOnce();

    rendered.unmount();
    window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT));
    expect(mocks.goHome).toHaveBeenCalledOnce();
  });
});
