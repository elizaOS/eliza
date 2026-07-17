// @vitest-environment jsdom

/**
 * Verifies the split notification data/shell boot boundaries and the global
 * open-center event against observable state and the browser event lifecycle.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    notificationBoots: 0,
    pushRegistrationBoots: 0,
    surface: "apps",
    tab: "settings",
  };
  return {
    state,
    goHome: vi.fn(() => {
      state.surface = "home";
    }),
    initNotifications: vi.fn(() => {
      state.notificationBoots += 1;
    }),
    initPushRegistration: vi.fn(async () => {
      state.pushRegistrationBoots += 1;
    }),
    setTab: vi.fn((tab: string) => {
      state.tab = tab;
    }),
  };
});

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: { setTab: typeof harness.setTab }) => unknown,
  ) => selector({ setTab: harness.setTab }),
}));
vi.mock("../../state/notifications/notification-store", () => ({
  initNotifications: harness.initNotifications,
}));
vi.mock("../../state/notifications/push-registration", () => ({
  initPushRegistration: harness.initPushRegistration,
}));
vi.mock("../../state/shell-surface-store", () => ({
  goHome: harness.goHome,
}));

import { OPEN_NOTIFICATION_CENTER_EVENT } from "../../events";
import {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./notifications-boot";

describe("notification boot boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.notificationBoots = 0;
    harness.state.pushRegistrationBoots = 0;
    harness.state.surface = "apps";
    harness.state.tab = "settings";
  });

  afterEach(cleanup);

  it("starts WebSocket ingress from the headless data boot", () => {
    const { container } = render(<NotificationsDataBoot />);

    expect(container.innerHTML).toBe("");
    expect(harness.state).toMatchObject({
      notificationBoots: 1,
      pushRegistrationBoots: 0,
    });
  });

  it("boots native push and removes notification-center routing on unmount", async () => {
    const rendered = render(<NotificationsShellBoot />);
    await waitFor(() =>
      expect(harness.state.pushRegistrationBoots).toBe(1),
    );

    expect(harness.state.notificationBoots).toBe(0);

    act(() => window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT)));
    expect(harness.state).toMatchObject({ surface: "home", tab: "chat" });

    rendered.unmount();
    harness.state.surface = "apps";
    harness.state.tab = "settings";
    window.dispatchEvent(new Event(OPEN_NOTIFICATION_CENTER_EVENT));
    expect(harness.state).toMatchObject({ surface: "apps", tab: "settings" });
  });
});
