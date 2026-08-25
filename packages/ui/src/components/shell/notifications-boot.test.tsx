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
  goHome: vi.fn(),
}));
const appState = vi.hoisted(() => ({ setTab: mocks.setTab }));

vi.mock("../../api/client", () => ({
  client: { onBaseUrlChange: mocks.onBaseUrlChange },
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));
vi.mock("../../state/shell-surface-store", () => ({ goHome: mocks.goHome }));
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

import { dispatchOpenNotificationCenter } from "../../events";
import {
  acknowledgeNotificationCenterOpenRequest,
  peekNotificationCenterOpenRequest,
} from "./notification-center-open-request";
import {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./notifications-boot";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  const pendingRequestId = peekNotificationCenterOpenRequest();
  if (pendingRequestId !== null) {
    acknowledgeNotificationCenterOpenRequest(pendingRequestId);
  }
  vi.clearAllMocks();
  appState.setTab = mocks.setTab;
  mocks.localTap.mockResolvedValue(undefined);
});

mocks.onBaseUrlChange.mockReturnValue(mocks.unsubscribeBase);

describe("notification boot boundaries", () => {
  it("starts ingress and native tap routing above startup/auth gates", async () => {
    const { container } = render(<NotificationsDataBoot />);
    expect(container.innerHTML).toBe("");
    expect(mocks.init).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.localTap).toHaveBeenCalledOnce());
  });

  it("retries a transient native tap bridge failure while boot remains mounted", async () => {
    vi.useFakeTimers();
    mocks.localTap
      .mockRejectedValueOnce(new Error("bridge not ready"))
      .mockResolvedValueOnce(undefined);

    render(<NotificationsDataBoot />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.localTap).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(mocks.localTap).toHaveBeenCalledTimes(2);
  });

  it("bounds native tap bridge retries and cancels pending work on unmount", async () => {
    vi.useFakeTimers();
    mocks.localTap.mockRejectedValue(new Error("bridge unavailable"));

    const { unmount } = render(<NotificationsDataBoot />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.localTap).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.localTap).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded native tap bridge retry budget", async () => {
    vi.useFakeTimers();
    mocks.localTap.mockRejectedValue(new Error("bridge unavailable"));

    render(<NotificationsDataBoot />);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.localTap).toHaveBeenCalledTimes(3);
  });

  it("boots native push, then routes notification-center ingress to chat", async () => {
    render(<NotificationsShellBoot />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());
    expect(mocks.localTap).not.toHaveBeenCalled();

    mocks.goHome.mockImplementationOnce(() => {
      expect(peekNotificationCenterOpenRequest()).toEqual(expect.any(Number));
    });

    act(() => dispatchOpenNotificationCenter());
    expect(mocks.goHome).toHaveBeenCalledOnce();
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
    expect(mocks.goHome.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTab.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("retains a cold-launch tap replayed before the signed-in shell mounts", async () => {
    mocks.goHome.mockImplementationOnce(() => {
      expect(peekNotificationCenterOpenRequest()).toEqual(expect.any(Number));
    });
    mocks.localTap.mockImplementationOnce(async () => {
      dispatchOpenNotificationCenter();
    });

    render(<NotificationsDataBoot />);

    await waitFor(() => expect(mocks.localTap).toHaveBeenCalledOnce());
    expect(mocks.goHome).not.toHaveBeenCalled();
    expect(mocks.setTab).not.toHaveBeenCalled();

    render(<NotificationsShellBoot />);

    await waitFor(() => expect(mocks.goHome).toHaveBeenCalledTimes(1));
    expect(mocks.goHome).toHaveBeenCalledTimes(1);
    expect(mocks.setTab).toHaveBeenCalledTimes(1);
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
  });

  it("completes navigation for a retained tap dispatched before shell effects mount", async () => {
    dispatchOpenNotificationCenter();
    expect(peekNotificationCenterOpenRequest()).toEqual(expect.any(Number));

    render(<NotificationsShellBoot />);

    await waitFor(() => expect(mocks.goHome).toHaveBeenCalledOnce());
    expect(mocks.setTab).toHaveBeenCalledOnce();
    expect(mocks.setTab).toHaveBeenCalledWith("chat");
    expect(peekNotificationCenterOpenRequest()).toEqual(expect.any(Number));
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

  it("does not re-register push ownership when the tab dispatcher identity changes", async () => {
    const view = render(<NotificationsShellBoot />);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledOnce());

    appState.setTab = vi.fn();
    view.rerender(<NotificationsShellBoot />);

    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.onBaseUrlChange).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeBase).not.toHaveBeenCalled();
  });
});
