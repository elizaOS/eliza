/** Verifies CapabilityToggle through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Renders CapabilityToggle with a mocked translator and asserts the shared
 * SettingsSwitchRow wiring, unavailable/missing-permission badges, and
 * click-to-toggle. jsdom, no backend.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";
import { mobileSystemPermissionDefinitions } from "./PermissionsSection";
import { CapabilityToggle, PermissionRow } from "./permission-controls";
import type { CapabilityDef } from "./permission-types";
import { SYSTEM_PERMISSIONS } from "./permission-types";

const appMock = vi.hoisted(() => ({
  t: (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: typeof appMock) => unknown) => sel(appMock),
  useAppSelectorShallow: (sel: (value: typeof appMock) => unknown) =>
    sel(appMock),
}));

const browserCap: CapabilityDef = {
  id: "browser",
  label: "Browser Control",
  labelKey: "permissionssection.capability.browser.label",
  description: "Automated web browsing and interaction",
  descriptionKey: "permissionssection.capability.browser.description",
  requiredPermissions: ["accessibility"],
};

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id: "browser",
    name: "Browser",
    description: "Browser plugin",
    enabled: true,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("CapabilityToggle", () => {
  beforeEach(() => {
    appMock.t = (key, options) => options?.defaultValue ?? key;
  });

  it("routes an enabled capability through SettingsSwitchRow", () => {
    const onToggle = vi.fn();
    render(
      <CapabilityToggle
        cap={browserCap}
        plugin={plugin()}
        permissionsGranted
        onToggle={onToggle}
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("data-agent-id")).toBe("perm-capability-browser");
    expect(sw.getAttribute("data-agent-role")).toBe("toggle");
    expect(sw.getAttribute("data-agent-label")).toBe("Browser Control");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Browser Control")).toBeTruthy();
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("stays disabled and shows badges when the plugin or permissions are missing", () => {
    render(
      <CapabilityToggle
        cap={browserCap}
        plugin={null}
        permissionsGranted={false}
        onToggle={() => {}}
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw).toHaveProperty("disabled", true);
    expect(screen.getByText("Plugin unavailable")).toBeTruthy();
    expect(
      screen.getByText("permissionssection.MissingPermissions"),
    ).toBeTruthy();
  });
});

const shellDef = SYSTEM_PERMISSIONS.find((def) => def.id === "shell");
if (!shellDef) {
  throw new Error("SYSTEM_PERMISSIONS must include shell");
}

describe("PermissionRow shell toggle", () => {
  it("routes the shell enable switch through SettingsSwitchRow", () => {
    const onToggleShell = vi.fn();
    render(
      <PermissionRow
        def={shellDef}
        status="granted"
        platform="darwin"
        canRequest={false}
        onRequest={() => {}}
        onOpenSettings={() => {}}
        isShell
        shellEnabled
        onToggleShell={onToggleShell}
      />,
    );
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("data-agent-id")).toBe("perm-shell-shell");
    expect(sw.getAttribute("data-agent-label")).toBe(
      "Shell Access shell access",
    );
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    expect(onToggleShell).toHaveBeenCalledWith(false);
  });
});

describe("mobile permission catalog", () => {
  it("uses the canonical microphone permission without promoting Apple Speech", () => {
    const iosIds = mobileSystemPermissionDefinitions("ios").map(
      (definition) => definition.id,
    );

    expect(iosIds).toContain("microphone");
    expect(iosIds).toContain("notifications");
    expect(iosIds).not.toContain("speech-recognition");
    expect(iosIds).not.toContain("screen-recording");
    expect(iosIds).not.toContain("shell");
    expect(iosIds).not.toContain("website-blocking");
  });
});
