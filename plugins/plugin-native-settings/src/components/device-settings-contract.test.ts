// @vitest-environment jsdom
//
// Contract test: validate the view's consumed shape against the REAL
// @elizaos/capacitor-system implementation rather than hand-written mocks.
//
// vitest.config.ts aliases "@elizaos/capacitor-system" to the real
// plugin-native-system/src/index.ts, so `System` here is the registered
// Capacitor plugin proxy. In jsdom (no native bridge) it falls back to the
// real `SystemWeb` web implementation — the same code that runs in a browser
// build. We instantiate SystemWeb directly to assert its response satisfies the
// DeviceSettingsStatus / SystemStatus contracts the view reads, then render the
// view wired to the live `System` proxy and assert the volume cards/percentages
// render from that real data. This proves the consumer parses the actual API
// shape, not a fixture that could drift from the provider.

import {
  type AndroidRoleName,
  type DeviceSettingsStatus,
  System,
  type SystemStatus,
  type SystemVolumeStream,
} from "@elizaos/capacitor-system";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// SystemWeb is the real web fallback; it is not re-exported from the package
// index (only definitions are), so import it from its module directly.
import { SystemWeb } from "../../../plugin-native-system/src/web";

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    type = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    // biome-ignore lint/a11y/useButtonType: test mock supplies an explicit default type.
    React.createElement("button", { type, ...props }, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
}));

import { DeviceSettingsAppView } from "./DeviceSettingsAppView";

const VALID_BRIGHTNESS_MODES = new Set<DeviceSettingsStatus["brightnessMode"]>([
  "manual",
  "automatic",
  "unknown",
]);
const VALID_VOLUME_STREAMS = new Set<SystemVolumeStream>([
  "music",
  "ring",
  "alarm",
  "notification",
  "system",
  "voiceCall",
]);
const VALID_ROLE_NAMES = new Set<AndroidRoleName>([
  "home",
  "dialer",
  "sms",
  "assistant",
]);

const VOLUME_LABELS: Record<SystemVolumeStream, string> = {
  music: "Media",
  ring: "Ring",
  alarm: "Alarm",
  notification: "Notifications",
  system: "System",
  voiceCall: "Voice call",
};

afterEach(() => {
  cleanup();
});

describe("device-settings contract — real SystemWeb output", () => {
  it("getDeviceSettings() satisfies the DeviceSettingsStatus shape the view consumes", async () => {
    const settings: DeviceSettingsStatus =
      await new SystemWeb().getDeviceSettings();

    expect(typeof settings.brightness).toBe("number");
    expect(Number.isFinite(settings.brightness)).toBe(true);
    expect(settings.brightness).toBeGreaterThanOrEqual(0);
    expect(settings.brightness).toBeLessThanOrEqual(1);

    expect(VALID_BRIGHTNESS_MODES.has(settings.brightnessMode)).toBe(true);
    expect(typeof settings.canWriteSettings).toBe("boolean");

    expect(Array.isArray(settings.volumes)).toBe(true);
    expect(settings.volumes.length).toBeGreaterThan(0);
    for (const volume of settings.volumes) {
      expect(VALID_VOLUME_STREAMS.has(volume.stream)).toBe(true);
      expect(Number.isFinite(volume.current)).toBe(true);
      expect(Number.isFinite(volume.max)).toBe(true);
      expect(volume.max).toBeGreaterThan(0);
      expect(volume.current).toBeGreaterThanOrEqual(0);
      expect(volume.current).toBeLessThanOrEqual(volume.max);
    }
  });

  it("getStatus() satisfies the SystemStatus shape the view consumes", async () => {
    const status: SystemStatus = await new SystemWeb().getStatus();

    expect(typeof status.packageName).toBe("string");
    expect(status.packageName.length).toBeGreaterThan(0);
    expect(Array.isArray(status.roles)).toBe(true);
    for (const role of status.roles) {
      expect(VALID_ROLE_NAMES.has(role.role)).toBe(true);
      expect(typeof role.androidRole).toBe("string");
      expect(typeof role.held).toBe("boolean");
      expect(typeof role.available).toBe("boolean");
      expect(Array.isArray(role.holders)).toBe(true);
    }
  });

  it("the registered System proxy returns the same real web shape used by the view", async () => {
    // Proves the alias resolves to the real plugin and falls back to SystemWeb.
    const viaProxy = await System.getDeviceSettings();
    const viaWeb = await new SystemWeb().getDeviceSettings();
    expect(viaProxy).toEqual(viaWeb);
  });

  it("renders volume cards parsed from the REAL System response (no mocks)", async () => {
    // The view's internal System.getDeviceSettings()/getStatus() resolve to the
    // real web fallback — this is an end-to-end parse of the live API shape.
    const real = await new SystemWeb().getDeviceSettings();

    render(
      React.createElement(DeviceSettingsAppView, {
        exitToApps: vi.fn(),
        uiTheme: "light" as const,
        t: (_key: string, opts?: { defaultValue?: string }) =>
          opts?.defaultValue ?? "",
      }),
    );

    // Stream count header reflects the real number of streams.
    await waitFor(() =>
      expect(screen.getByText(`${real.volumes.length} streams`)).toBeTruthy(),
    );

    // Each real stream renders a card with the correct label and live percent
    // computed from the real current/max.
    for (const volume of real.volumes) {
      const scoped = within(
        screen.getByTestId(`device-settings-volume-card-${volume.stream}`),
      );
      expect(scoped.getByText(VOLUME_LABELS[volume.stream])).toBeTruthy();
      const expectedPercent = `${Math.round((volume.current / volume.max) * 100)}%`;
      expect(scoped.getByText(expectedPercent)).toBeTruthy();
      // Slider value + max derive from the real volume entry.
      const slider = screen.getByTestId(
        `device-settings-volume-${volume.stream}`,
      ) as HTMLInputElement;
      expect(slider.value).toBe(String(volume.current));
      expect(slider.max).toBe(String(volume.max));
    }

    // The real web getStatus() returns no Android roles -> the honest empty
    // state, not a fabricated role list.
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
});
