/** Verifies the familiar grouped-row compact Settings hub. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsHubList } from "./SettingsHubList";
import type { GroupedSettingsSections } from "./settings-sections";

const EmptySection = () => null;

function section(
  id: string,
  overrides: Partial<GroupedSettingsSections[number]["items"][number]> = {},
): GroupedSettingsSections[number]["items"][number] {
  return {
    id,
    label: `settings.${id}`,
    defaultLabel: id,
    icon: Settings,
    tone: "neutral",
    hue: "slate",
    titleKey: `settings.${id}`,
    defaultTitle: id,
    group: "system",
    Component: EmptySection,
    ...overrides,
  };
}

afterEach(cleanup);

describe("SettingsHubList", () => {
  it("renders labelled canonical groups with medallion navigation rows", () => {
    const grouped: GroupedSettingsSections = [
      {
        group: "agent",
        label: "Agent",
        items: [section("Basics", { group: "agent" })],
      },
      {
        group: "system",
        label: "App",
        items: [section("Appearance")],
      },
    ];

    render(
      <SettingsHubList
        grouped={grouped}
        onSelect={vi.fn()}
        label={(_key, fallback) => fallback}
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    const agentGroup = screen.getByTestId("settings-hub-group-agent");
    const basics = screen.getByTestId("settings-hub-row-Basics");

    expect(navigation.getAttribute("data-slot")).toBe("settings-hub-list");
    expect(navigation.className).toContain("px-4");
    expect(agentGroup.tagName).toBe("SECTION");
    expect(agentGroup.getAttribute("data-slot")).toBe("settings-group");
    expect(
      screen.getByRole("heading", { name: "Agent", level: 2 }),
    ).toBeTruthy();
    expect(
      agentGroup.querySelector("[data-slot='settings-group-surface']"),
    ).toBeTruthy();
    expect(basics.tagName).toBe("BUTTON");
    expect(basics.getAttribute("data-slot")).toBe("settings-row");
    expect(
      basics.querySelector("[data-slot='settings-row-icon-container']"),
    ).toBeTruthy();
    expect(
      basics.querySelector("[data-slot='settings-row-chevron']"),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-hub-row-Appearance")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "App", level: 2 })).toBeTruthy();
  });

  it("opens a destination immediately without category-expansion ceremony", () => {
    const onSelect = vi.fn();
    const grouped: GroupedSettingsSections = [
      {
        group: "system",
        label: "App",
        items: [section("Appearance"), section("Notifications")],
      },
    ];

    render(
      <SettingsHubList
        grouped={grouped}
        onSelect={onSelect}
        label={(_key, fallback) => fallback}
      />,
    );

    fireEvent.click(screen.getByTestId("settings-hub-row-Notifications"));
    expect(onSelect).toHaveBeenCalledWith("Notifications");
  });
});
