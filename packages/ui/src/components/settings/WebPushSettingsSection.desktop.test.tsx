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
const platform = vi.hoisted(() => ({ desktop: true }));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: bridge.request,
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
});

describe("WebPushSettingsSection desktop notification parity", () => {
  it("sends a real system notification through the desktop bridge", async () => {
    bridge.request.mockResolvedValueOnce({ id: "notification-1" });
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    expect(bridge.request).toHaveBeenCalledWith({
      rpcMethod: "desktopShowNotification",
      ipcChannel: "desktop:showNotification",
      params: {
        title: "Eliza Test Notification",
        body: "Notifications from the Eliza desktop app are working.",
      },
    });
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
    bridge.request.mockResolvedValueOnce(null);
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "The desktop app cannot send a test notification.",
      );
    });
  });

  it("shows an error when the desktop notification acknowledgement is malformed", async () => {
    bridge.request.mockResolvedValueOnce(undefined);
    render(<WebPushSettingsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Send test notification" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "The desktop app cannot send a test notification.",
      );
    });
  });
});
