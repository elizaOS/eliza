// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reactJsxDevRuntimePath, reactJsxRuntimePath, reactModulePath } =
  vi.hoisted(() => {
    const cwd = process.cwd();
    const workspaceRoot = cwd.endsWith("/eliza") ? cwd.slice(0, -6) : cwd;
    const reactRoot = `${workspaceRoot}/node_modules/react`;
    return {
      reactJsxDevRuntimePath: `${reactRoot}/jsx-dev-runtime.js`,
      reactJsxRuntimePath: `${reactRoot}/jsx-runtime.js`,
      reactModulePath: `${reactRoot}/index.js`,
    };
  });

vi.mock("react", () => require(reactModulePath));
vi.mock("react/jsx-runtime", () => require(reactJsxRuntimePath));
vi.mock("react/jsx-dev-runtime", () => require(reactJsxDevRuntimePath));
vi.mock("@elizaos/app-core", () => ({
  Badge: "span",
  Button: "button",
  useApp: () => ({ t: (key: string) => key }),
}));

import { WebsiteBlockerSettingsCard } from "./WebsiteBlockerSettingsCard";

const React = require(reactModulePath) as typeof import("react");

type WebsiteBlockerSettingsCardProps = ComponentProps<
  typeof WebsiteBlockerSettingsCard
>;

function renderSettingsCard(props: WebsiteBlockerSettingsCardProps): void {
  render(React.createElement(WebsiteBlockerSettingsCard, props));
}

afterEach(() => {
  cleanup();
});

describe("WebsiteBlockerSettingsCard", () => {
  it("runs the approval request button when permission can be requested", () => {
    const onRequestPermission = vi.fn();

    renderSettingsCard({
      mode: "desktop",
      platform: "darwin",
      permission: {
        status: "not-determined",
        canRequest: true,
        reason: "admin approval required",
      },
      onRequestPermission,
    });

    fireEvent.click(screen.getByRole("button", { name: "Request Approval" }));

    expect(onRequestPermission).toHaveBeenCalledOnce();
    expect(screen.getByText("Needs Approval")).toBeTruthy();
    expect(screen.getByText("admin approval required")).toBeTruthy();
  });

  it("runs the hosts-file action when permission cannot be requested directly", () => {
    const onOpenPermissionSettings = vi.fn();

    renderSettingsCard({
      mode: "desktop",
      platform: "linux",
      permission: {
        status: "denied",
        canRequest: false,
        reason: "edit hosts manually",
      },
      onOpenPermissionSettings,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Hosts File" }));

    expect(onOpenPermissionSettings).toHaveBeenCalledOnce();
    expect(screen.getByText("Needs Admin")).toBeTruthy();
    expect(screen.getByText("edit hosts manually")).toBeTruthy();
  });

  it("does not expose desktop permission buttons in web mode", () => {
    renderSettingsCard({
      mode: "web",
      platform: "darwin",
      permission: {
        status: "not-determined",
        canRequest: true,
        reason: "admin approval required",
      },
      onRequestPermission: vi.fn(),
      onOpenPermissionSettings: vi.fn(),
    });

    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.getByText(
        "Hosts-file website blocking runs in the desktop app. Use Milady on macOS, Windows, or Linux to enable SelfControl-style blocking for your agent.",
      ),
    ).toBeTruthy();
  });
});
