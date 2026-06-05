// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

// SettingsView's own responsibility is hub → section navigation + a loadPlugins
// kickoff on mount — the individual section bodies are heavy, independently
// data-fetching components. To test the view in isolation (its real, non-
// trivial logic) we replace the section registry with lightweight stub
// components. This is deliberate partial coverage: we exercise SettingsView's
// navigation/lifecycle behavior, not each section's internals (which warrant
// their own tests). The useApp + section-registry mocks are the seams this
// refactor must keep stable.
const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({ useApp: () => appMock.value }));

vi.mock("../settings/settings-sections", () => ({
  SECTION_HUE_MEDALLION_CLASS: {
    accent: "",
    amber: "",
    rose: "",
    slate: "",
  },
  SETTINGS_GROUP_LABEL: {
    agent: "Agent",
    system: "System",
    security: "Security",
  },
  SETTINGS_GROUP_ORDER: ["agent", "system", "security"],
  SETTINGS_SECTIONS: [
    {
      id: "identity",
      label: "settings.sections.identity.label",
      defaultLabel: "Basics",
      icon: Settings,
      tone: "neutral",
      hue: "slate",
      group: "agent",
      titleKey: "settings.sections.identity.label",
      defaultTitle: "Basics",
      Component: () => <div data-testid="stub-identity">Identity body</div>,
    },
    {
      id: "runtime",
      label: "settings.sections.runtime.label",
      defaultLabel: "Runtime",
      icon: Settings,
      tone: "neutral",
      hue: "slate",
      group: "system",
      titleKey: "settings.sections.runtime.label",
      defaultTitle: "Runtime",
      Component: () => <div data-testid="stub-runtime">Runtime body</div>,
    },
  ],
  readSettingsHashSection: () => null,
  replaceSettingsHash: vi.fn(),
  settingsSectionLabel: (section: { defaultLabel: string }) =>
    section.defaultLabel,
  settingsSectionTitle: (section: { defaultTitle: string }) =>
    section.defaultTitle,
}));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    t,
    loadPlugins: vi.fn(async () => {}),
    walletEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  appMock.value = makeContext();
});

afterEach(() => cleanup());

describe("SettingsView", () => {
  it("calls loadPlugins on mount and renders the hub tiles", async () => {
    render(<SettingsView />);

    await waitFor(() => {
      expect(appMock.value.loadPlugins).toHaveBeenCalled();
    });
    // The hub shows a tile per registered section; no section body is mounted
    // until a tile is selected.
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.getByText("Runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
  });

  it("clicking a hub tile opens that section full-width", () => {
    render(<SettingsView />);

    const runtimeTile = screen
      .getByText("Runtime")
      .closest("button") as HTMLButtonElement;
    expect(runtimeTile).toBeTruthy();

    fireEvent.click(runtimeTile);

    // The section body is now mounted, and a back affordance is present.
    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("respects an initialSection prop by opening that section directly", () => {
    render(<SettingsView initialSection="runtime" />);

    expect(screen.getByTestId("stub-runtime")).toBeTruthy();
    expect(screen.queryByTestId("stub-identity")).toBeNull();
  });

  it("back affordance returns to the hub", () => {
    render(<SettingsView initialSection="runtime" />);

    const back = screen.getByText("Settings").closest("button");
    expect(back).toBeTruthy();
    fireEvent.click(back as HTMLButtonElement);

    // Both tiles are visible again and no section body is mounted.
    expect(screen.getByText("Basics")).toBeTruthy();
    expect(screen.queryByTestId("stub-runtime")).toBeNull();
  });
});
