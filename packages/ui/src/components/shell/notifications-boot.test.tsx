/** Verifies notification boot boundaries through the package's configured test harness. */
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  localTap: vi.fn(async () => undefined),
  push: vi.fn(async () => undefined),
  refreshPush: vi.fn(async () => undefined),
  unsubscribeBase: vi.fn(),
  onBaseUrlChange: vi.fn(),
  seed: vi.fn(async () => undefined),
  setTab: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  client: { onBaseUrlChange: mocks.onBaseUrlChange },
}));

vi.mock("../../state", () => ({ useAppSelector: () => mocks.setTab }));
vi.mock("../../bridge/native-notifications", () => ({
  initLocalNotificationTapRouting: mocks.localTap,
}));
vi.mock("../../state/notifications/notification-store", () => ({
  initNotifications: mocks.init,
  seedDevNotificationsIfEmpty: mocks.seed,
}));
vi.mock("../../state/notifications/push-registration", () => ({
  initPushRegistration: mocks.push,
  refreshPushRegistrationAuthority: mocks.refreshPush,
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

mocks.onBaseUrlChange.mockReturnValue(mocks.unsubscribeBase);

describe("notification boot boundaries", () => {
  it("starts WebSocket ingress from the headless data boot", () => {
    const { container } = render(<NotificationsDataBoot />);
    expect(container.innerHTML).toBe("");
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it("boots native push and local-tap routing, then routes notification-center ingress to chat", async () => {
    render(<NotificationsShellBoot />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());
    expect(mocks.localTap).toHaveBeenCalledOnce();

    act(() => window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT)));
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
  });

  it("routes a retained cold-launch tap replayed during native listener attachment", async () => {
    mocks.localTap.mockImplementationOnce(async () => {
      window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT));
    });

    render(<NotificationsShellBoot />);

    await waitFor(() => expect(mocks.localTap).toHaveBeenCalledOnce());
    expect(mocks.setTab).toHaveBeenCalledTimes(1);
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
  });

  it("rotates push ownership on base and token authority changes", async () => {
    const { unmount } = render(<NotificationsShellBoot />);
    const baseListener = mocks.onBaseUrlChange.mock.calls[0]?.[0];
    expect(baseListener).toBeTypeOf("function");

    act(() => baseListener?.("https://agent-b.example"));
    act(() => window.dispatchEvent(new Event("steward-token-sync")));
    await waitFor(() => expect(mocks.refreshPush).toHaveBeenCalledTimes(2));

    unmount();
    expect(mocks.unsubscribeBase).toHaveBeenCalledOnce();
  });
});
