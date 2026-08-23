/**
 * Verifies the cloud-only panel's deterministic narrow-screen hub-to-section
 * navigation without loading live settings sections or native bridges.
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

vi.mock("../../../state", () => ({
  useAppSelector: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ elizaCloudConnected: false }),
}));

vi.mock("./cloud-management-auth", () => ({
  useHasCloudManagementCredential: () => false,
}));

vi.mock("./cloud-panel-routing", () => ({
  navigateCloudPanel: vi.fn(),
  readCloudPanelHash: () => "general",
  replaceCloudPanel: vi.fn(),
  subscribeCloudPanelHash: () => () => {},
}));

vi.mock("./cloud-panel-sections", () => {
  const Icon = () => <span aria-hidden="true" />;
  const sections = [
    {
      id: "general",
      label: "General",
      subtitle: "Desktop behavior",
      group: "general",
      icon: Icon,
      Component: () => <div>General section</div>,
    },
    {
      id: "voice",
      label: "Voice",
      subtitle: "Voice behavior",
      group: "agent",
      icon: Icon,
      Component: () => <div>Voice section</div>,
    },
  ];
  return {
    CLOUD_PANEL_SECTIONS: sections,
    groupedCloudPanelSections: () => ({
      general: [sections[0]],
      agent: [sections[1]],
    }),
    resolveCloudPanelSection: (id: string) =>
      sections.some((section) => section.id === id) ? id : "general",
  };
});

import { CloudSettingsPanel } from "./CloudSettingsPanel";

describe("CloudSettingsPanel narrow navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
  });

  it("returns from section content to the settings hub", () => {
    render(<CloudSettingsPanel />);

    fireEvent.click(screen.getByRole("button", { name: /Voice/ }));
    expect(screen.getByText("Voice section")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: /General/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Voice/ })).toBeTruthy();
  });
});
