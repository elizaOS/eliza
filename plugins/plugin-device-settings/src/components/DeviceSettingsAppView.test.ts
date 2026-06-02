// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const systemBridge = vi.hoisted(() => ({
  getDeviceSettings: vi.fn(),
  getStatus: vi.fn(),
  setScreenBrightness: vi.fn(),
  setVolume: vi.fn(),
  requestRole: vi.fn(),
  openSettings: vi.fn(),
  openWriteSettings: vi.fn(),
  openDisplaySettings: vi.fn(),
  openSoundSettings: vi.fn(),
  openNetworkSettings: vi.fn(),
}));

vi.mock("@elizaos/capacitor-system", () => ({
  System: systemBridge,
}));

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    type = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    // biome-ignore lint/a11y/useButtonType: test mock supplies an explicit default type.
    React.createElement("button", { type, ...props }, children),
}));

import { DeviceSettingsAppView } from "./DeviceSettingsAppView";

const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? "";

function mockBridge() {
  systemBridge.getDeviceSettings.mockResolvedValue({
    brightness: Number.NaN,
    brightnessMode: "manual",
    canWriteSettings: true,
    volumes: [
      {
        stream: "music",
        current: 999,
        max: 15,
      },
    ],
  });
  systemBridge.getStatus.mockResolvedValue({
    packageName: "ai.eliza",
    roles: [
      {
        role: "sms",
        androidRole: "android.app.role.SMS",
        held: false,
        holders: [],
        available: true,
      },
    ],
  });
  systemBridge.setScreenBrightness.mockResolvedValue({
    brightness: 2,
    brightnessMode: "manual",
    canWriteSettings: true,
    volumes: [],
  });
  systemBridge.setVolume.mockResolvedValue({
    stream: "music",
    current: 20,
    max: 15,
  });
  systemBridge.requestRole.mockResolvedValue({
    role: "sms",
    held: true,
    resultCode: 0,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DeviceSettingsAppView", () => {
  it("clamps hostile bridge brightness and volume values before writing them back", async () => {
    mockBridge();

    render(
      React.createElement(DeviceSettingsAppView, { exitToApps: vi.fn(), t }),
    );

    const brightness = await screen.findByTestId("device-settings-brightness");
    expect((brightness as HTMLInputElement).value).toBe("0");

    const musicVolume = await screen.findByTestId(
      "device-settings-volume-music",
    );
    expect((musicVolume as HTMLInputElement).value).toBe("15");

    fireEvent.change(musicVolume, { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("device-settings-apply-volume-music"));

    await waitFor(() =>
      expect(systemBridge.setVolume).toHaveBeenCalledWith({
        stream: "music",
        volume: 15,
      }),
    );

    fireEvent.click(screen.getByTestId("device-settings-apply-brightness"));
    await waitFor(() =>
      expect(systemBridge.setScreenBrightness).toHaveBeenCalledWith({
        brightness: 0,
      }),
    );
  });

  it("backs out through overlay context and reports system panel failures", async () => {
    mockBridge();
    systemBridge.openNetworkSettings.mockRejectedValue(
      new Error("network settings unavailable"),
    );
    const exitToApps = vi.fn();

    render(React.createElement(DeviceSettingsAppView, { exitToApps, t }));

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(exitToApps).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("device-settings-open-network"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "network settings unavailable",
    );
  });
});
