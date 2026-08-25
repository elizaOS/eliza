/** Verifies that plugin activation uses the canonical switch without redundant visible ON or OFF copy. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../api";
import { PluginCard } from "./PluginCard";

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: null, agentProps: {} }),
}));

vi.mock("../../state", () => ({
  useAppSelector: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? (key === "common.on" ? "ON" : "OFF"),
}));

vi.mock("./PluginVisual", () => ({
  PluginVisual: () => <span aria-hidden="true">icon</span>,
}));

afterEach(cleanup);

const plugin: PluginInfo = {
  id: "plugin-browser",
  name: "Browser Workspace",
  description: "Agent-controlled browser workspace",
  enabled: true,
  configured: true,
  envKey: null,
  category: "feature",
  isActive: true,
  source: "bundled",
  parameters: [],
  validationErrors: [],
  validationWarnings: [],
};

const defaultProps = {
  plugin,
  allowCustomOrder: false,
  pluginSettingsOpen: new Set<string>(),
  togglingPlugins: new Set<string>(),
  hasPluginToggleInFlight: false,
  installingPlugins: new Set<string>(),
  updatingPlugins: new Set<string>(),
  uninstallingPlugins: new Set<string>(),
  installProgress: new Map<string, { phase: string; message: string }>(),
  releaseStreamSelections: {} as Record<string, "latest" | "beta">,
  draggingId: null,
  dragOverId: null,
  pluginDescriptionFallback: "No description",
  onToggle: vi.fn(),
  onToggleSettings: vi.fn(),
  onInstall: vi.fn(),
  onUpdate: vi.fn(),
  onUninstall: vi.fn(),
  onReleaseStreamChange: vi.fn(),
  onOpenExternalUrl: vi.fn(),
  installProgressLabel: (message?: string) => message ?? "Installing",
  installLabel: "Install",
  loadFailedLabel: "Load failed",
  notInstalledLabel: "Not installed",
};

describe("PluginCard activation control", () => {
  it("renders a checked switch with an action label and no visible state copy", () => {
    render(<PluginCard {...defaultProps} />);

    const toggle = screen.getByRole("switch", {
      name: "OFF Browser Workspace",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("ON")).toBeNull();
    expect(screen.queryByText("OFF")).toBeNull();

    fireEvent.click(toggle);
    expect(defaultProps.onToggle).toHaveBeenCalledWith("plugin-browser", false);
  });
});
