// @vitest-environment jsdom
//
// Three-state guard for the mobile-signals permissions panel (#12784): when
// the plugin is present but its permissions probe throws, the panel must
// render an explicit error row — not disappear like the designed "plugin not
// on this platform" degrade. The designed-hidden state (no checkPermissions
// on this build) still renders nothing.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSignalsPermissionStatus } from "../../bridge/native-plugins";

const pluginMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../bridge/native-plugins", () => ({
  getMobileSignalsPlugin: () => pluginMock.value,
  // The push-registration module (pulled in transitively by the settings tree)
  // reads this at import time; the full-module mock must expose it or vitest
  // throws "No getPushNotificationsPlugin export is defined on the mock".
  getPushNotificationsPlugin: () => ({}),
}));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (s: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

// The panel pulls SettingsGroup/SettingsActionButton for the success render;
// they render fine in jsdom, so only the data seams above are mocked.

import { MobileSignalsPermissionsPanel } from "./PermissionsSection";

const grantedStatus: MobileSignalsPermissionStatus = {
  status: "granted",
  canRequest: false,
  screenTime: {
    supported: false,
    requirements: {
      entitlements: { familyControls: "" },
      frameworks: [],
      deviceActivityReportExtension: false,
      deviceActivityMonitorExtension: false,
    },
    entitlements: { familyControls: false },
    provisioning: {
      satisfied: false,
      inspected: "not-inspectable",
      reason: null,
    },
    authorization: { status: "unavailable", canRequest: false },
    reportAvailable: false,
    coarseSummaryAvailable: false,
    thresholdEventsAvailable: false,
    rawUsageExportAvailable: false,
    reason: null,
  },
  setupActions: [],
  permissions: { sleep: true, biometrics: true },
};

beforeEach(() => {
  pluginMock.value = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MobileSignalsPermissionsPanel three-state rendering", () => {
  it("renders nothing when the plugin does not expose checkPermissions (designed degrade)", async () => {
    pluginMock.value = {};

    const { container } = render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(screen.queryByText("Loading permissions...")).toBeNull(),
    );
    expect(screen.queryByTestId("mobile-signals-permissions-error")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders the explicit error row when the permissions probe throws", async () => {
    pluginMock.value = {
      checkPermissions: vi.fn().mockRejectedValue(new Error("bridge exploded")),
    };

    render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(
        screen.getByTestId("mobile-signals-permissions-error"),
      ).not.toBeNull(),
    );
    expect(
      screen.getByTestId("mobile-signals-permissions-error").textContent,
    ).toContain("Could not read device permissions.");
  });

  it("renders the panel when the probe resolves", async () => {
    pluginMock.value = {
      checkPermissions: vi.fn().mockResolvedValue(grantedStatus),
    };

    render(<MobileSignalsPermissionsPanel />);

    await waitFor(() =>
      expect(screen.getByText("LifeOps Signals")).not.toBeNull(),
    );
    expect(screen.queryByTestId("mobile-signals-permissions-error")).toBeNull();
  });
});
