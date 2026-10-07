/** Verifies notification boot boundaries through the package's configured test harness. */
// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  localTap: vi.fn(async () => undefined),
  push: vi.fn(async (): Promise<void> => undefined),
  refreshPush: vi.fn(
    async (_deps?: unknown, _force?: boolean): Promise<void> => undefined,
  ),
  unsubscribeBase: vi.fn(),
  onBaseUrlChange: vi.fn(),
  seed: vi.fn(async () => undefined),
  setTab: vi.fn(),
  goHome: vi.fn(),
  loggerError: vi.fn(),
}));
const appState = vi.hoisted(() => ({ setTab: mocks.setTab }));

vi.mock("../../api/client", () => ({
  client: { onBaseUrlChange: mocks.onBaseUrlChange },
}));

vi.mock("../../state/app-store", () => ({
  useAppSelector: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));
vi.mock("../../state/shell-surface-store", () => ({ goHome: mocks.goHome }));
vi.mock("../../logger.ts", () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
}));
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

import type { PushRegistrationToken } from "../../bridge/native-plugins";
import { APP_RESUME_EVENT, dispatchOpenNotificationCenter } from "../../events";
import {
  acknowledgeNotificationCenterOpenRequest,
  peekNotificationCenterOpenRequest,
} from "../../state/notifications/notification-center-open-request";
import {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./notifications-boot";

// Collect the real module before timing the permission/resume behavior. A cold
// transform of its dependency graph must not consume the behavioral deadline.
const registration = await vi.importActual<
  typeof import("../../state/notifications/push-registration")
>("../../state/notifications/push-registration");

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
  mocks.push.mockResolvedValue(undefined);
  mocks.refreshPush.mockResolvedValue(undefined);
  registration.__resetPushRegistrationForTests();
});

mocks.onBaseUrlChange.mockReturnValue(mocks.unsubscribeBase);

describe("notification boot boundaries", () => {
  it.each([false, true])(
    "preserves same-authority native delivery on an identical-base reconnect (focused=%s)",
    async (focused) => {
      let enabled = true;
      let key = "same-profile-same-base-same-token";
      let nativeOwner = "a".repeat(64);
      let windowFocused = true;
      const order: string[] = [];
      const register = vi.fn(async () => {
        order.push("register");
        if (!windowFocused) throw new Error("Native foreground start denied");
        enabled = true;
      });
      const unregister = vi.fn(async () => {
        order.push("unregister");
        enabled = false;
      });
      const deps: import("../../state/notifications/push-registration").PushRegistrationDeps =
        {
          getPlatform: () => "android",
          isRemotePushEnabled: () => true,
          getPlugin: () => ({
            checkPermissions: async () => ({ receive: "granted" }),
            getNativeNotificationDeliveryStatus: async () => ({
              transport: "native",
              owner: nativeOwner,
              activated: true,
              enabled,
              connected: enabled,
              state: enabled ? "connected" : "stopped",
              batteryExempt: true,
              backgroundReliable: enabled,
              notificationsAllowed: true,
              inbox: null,
            }),
            register,
            unregister,
            addListener: async () => ({ remove: async () => {} }),
          }),
          registerToken: vi.fn(async () => ({ ok: true })),
          unregisterToken: vi.fn(async () => ({ ok: true })),
          navigate: vi.fn(),
          captureAuthority: () => ({
            key,
            registerToken: vi.fn(async () => ({ ok: true })),
            unregisterToken: vi.fn(async () => ({ ok: true })),
          }),
        };
      await registration.initPushRegistration(deps);
      register.mockClear();
      order.length = 0;
      windowFocused = focused;
      mocks.push.mockImplementation(() =>
        registration.initPushRegistration(deps),
      );
      let transition: Promise<void> = Promise.resolve();
      mocks.refreshPush.mockImplementation((_unused, force) => {
        transition = registration.refreshPushRegistrationAuthority(deps, force);
        return transition;
      });
      render(<NotificationsShellBoot />);
      const onBase = mocks.onBaseUrlChange.mock.calls.at(-1)?.[0];
      act(() => onBase?.("http://same-base.example"));
      await act(async () => {
        await transition.catch(() => {});
      });
      expect(enabled).toBe(true);
      expect(unregister).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();

      // A real profile/token change on that same URL must still retire first.
      key = "different-profile-or-token-at-same-base";
      nativeOwner = "b".repeat(64);
      windowFocused = true;
      act(() => onBase?.("http://same-base.example"));
      await act(async () => {
        await transition;
      });
      expect(order).toEqual(["unregister", "register"]);
      expect(enabled).toBe(true);
      expect(registration.captureNativeNotificationOwner()).toBe(nativeOwner);
    },
  );
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
    expect(mocks.seed).not.toHaveBeenCalled();

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

  it("contains a native push provider failure at the shell boundary", async () => {
    const error = new Error("push-unavailable: Firebase is not configured");
    mocks.push.mockRejectedValueOnce(error);

    render(<NotificationsShellBoot />);

    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith(
        { src: "push-registration", error },
        "[push-registration] native registration unavailable",
      ),
    );
  });

  it("registers once after an external permission grant on resume without prompting", async () => {
    registration.__resetPushRegistrationForTests();
    let permission: "denied" | "granted" = "denied";
    let onRegistered: ((token: PushRegistrationToken) => void) | undefined;
    const registerToken = vi.fn(async () => undefined);
    const unregisterToken = vi.fn(async () => undefined);
    const plugin = {
      checkPermissions: vi.fn(async () => ({ receive: permission })),
      requestPermissions: vi.fn(async () => ({ receive: permission })),
      addListener: vi.fn(async (eventName: string, listener: unknown) => {
        if (eventName === "registration") {
          onRegistered = listener as (token: PushRegistrationToken) => void;
        }
        return { remove: vi.fn(async () => undefined) };
      }),
      register: vi.fn(async () => {
        onRegistered?.({ value: "qa-device-token" });
      }),
    };
    mocks.push.mockImplementation(() =>
      registration.initPushRegistration({
        getPlatform: () => "android",
        isRemotePushEnabled: () => true,
        getPlugin: () => plugin,
        registerToken,
        unregisterToken,
        navigate: vi.fn(),
        captureAuthority: () => ({
          key: "owner-a",
          registerToken,
          unregisterToken,
        }),
      }),
    );
    const view = render(<NotificationsShellBoot />);
    try {
      await act(async () => {
        await mocks.push.mock.results[0]?.value;
      });
      expect(plugin.register).not.toHaveBeenCalled();

      // A resume while permission is still denied remains non-interactive.
      await act(async () => {
        document.dispatchEvent(new Event(APP_RESUME_EVENT));
        await mocks.push.mock.results[1]?.value;
      });
      expect(plugin.register).not.toHaveBeenCalled();

      permission = "granted";
      await act(async () => {
        document.dispatchEvent(new Event(APP_RESUME_EVENT));
        await mocks.push.mock.results[2]?.value;
      });
      await waitFor(() =>
        expect(registerToken).toHaveBeenCalledWith(
          "android",
          "qa-device-token",
        ),
      );

      await act(async () => {
        document.dispatchEvent(new Event(APP_RESUME_EVENT));
        document.dispatchEvent(new Event(APP_RESUME_EVENT));
      });
      expect(plugin.register).toHaveBeenCalledOnce();
      expect(registerToken).toHaveBeenCalledOnce();
      expect(plugin.requestPermissions).not.toHaveBeenCalled();
      expect(mocks.refreshPush).not.toHaveBeenCalled();

      view.unmount();
      mocks.push.mockClear();
      document.dispatchEvent(new Event(APP_RESUME_EVENT));
      expect(mocks.push).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      registration.__resetPushRegistrationForTests();
    }
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
