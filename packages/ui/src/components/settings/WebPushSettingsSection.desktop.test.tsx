/**
 * Verifies the canonical Notifications section retains the desktop system
 * notification check while portable runtimes keep the shared web-push UI.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebPushSettingsSection } from "./WebPushSettingsSection";

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
const platform = vi.hoisted(() => ({ desktop: true, mobile: false }));

vi.mock("../../bridge/notification-delivery", () => ({
  deliverSystemNotification: bridge.request,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => platform.mobile },
}));

vi.mock("../../platform", () => ({
  isDesktopPlatform: () => platform.desktop,
}));

vi.mock("../../state/notifications/useWebPush", () => ({
  useWebPush: () => ({
    state: "unsupported",
    busy: false,
    error: null,
    ready: true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: (options: { id: string }) => ({
    ref: null,
    agentProps: { "data-agent-id": options.id },
  }),
}));

afterEach(() => {
  cleanup();
  bridge.request.mockReset();
  platform.desktop = true;
  platform.mobile = false;
});

describe("WebPushSettingsSection desktop notification parity", () => {
  it("uses native delivery on mobile without offering web push", async () => {
    platform.desktop = false;
    platform.mobile = true;
    bridge.request.mockResolvedValueOnce("local");
    render(<WebPushSettingsSection />);
    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );
    await waitFor(() => expect(bridge.request).toHaveBeenCalledOnce());
    expect(screen.queryByText("Push notifications")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("dispatches a native test without requesting permission or showing browser push", async () => {
    bridge.request.mockResolvedValueOnce("desktop");
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    expect(bridge.request).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Notifications from Eliza are working.",
        requestPermission: false,
        priority: "normal",
      }),
    );
    expect(screen.queryByText("Push notifications")).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "Send test notification",
        }).disabled,
      ).toBe(false);
    });
  });

  it("does not add a desktop-only action to portable settings", () => {
    platform.desktop = false;
    render(<WebPushSettingsSection />);

    expect(
      screen.queryByRole("button", { name: "Send test notification" }),
    ).toBeNull();
  });

  it("shows an error when the desktop notification method is unavailable", async () => {
    bridge.request.mockResolvedValueOnce("none");
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Cannot send a system notification. Check notification access above and in your device settings.",
      );
    });
  });

  it("shows unexpected native failures at the settings boundary", async () => {
    bridge.request.mockRejectedValueOnce(
      new Error("Native transport disconnected"),
    );
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Native transport disconnected",
      );
    });
  });
});
