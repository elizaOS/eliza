/** Verifies the shared compact/wide Settings information architecture. */
import { describe, expect, it } from "vitest";
import { buildSettingsNavigationGroups } from "./settings-navigation-model";
import type { GroupedSettingsSections } from "./settings-sections";

function groupedFixture(): GroupedSettingsSections {
  return [
    {
      group: "agent",
      label: "Agent",
      items: [
        { id: "basics" },
        { id: "capabilities", developerOnly: true },
      ] as GroupedSettingsSections[number]["items"],
    },
    {
      group: "developer",
      label: "Developer",
      items: [
        { id: "api-keys", prominence: "secondary" },
        { id: "applications", prominence: "secondary" },
      ] as GroupedSettingsSections[number]["items"],
    },
  ];
}

describe("buildSettingsNavigationGroups", () => {
  it("keeps the everyday hub concise and drops all-specialist groups", () => {
    const result = buildSettingsNavigationGroups(groupedFixture(), null);

    expect(result.map(({ group }) => group)).toEqual(["agent"]);
    expect(result[0]?.items.map(({ id }) => id)).toEqual(["basics"]);
  });

  it("retains a directly-opened specialist destination in the wide rail", () => {
    const result = buildSettingsNavigationGroups(
      groupedFixture(),
      "applications",
    );

    expect(result.map(({ group }) => group)).toEqual(["agent", "developer"]);
    expect(result[1]?.items.map(({ id }) => id)).toEqual(["applications"]);
  });

  it("consolidates legacy Basics and Notifications out of the everyday hub", () => {
    const groups = [
      {
        group: "agent",
        label: "Agent",
        items: [{ id: "identity", prominence: "secondary" }, { id: "voice" }],
      },
      {
        group: "system",
        label: "App",
        items: [
          { id: "appearance" },
          { id: "notifications", prominence: "secondary" },
        ],
      },
    ] as GroupedSettingsSections;

    const result = buildSettingsNavigationGroups(groups, null);

    expect(result.flatMap(({ items }) => items.map(({ id }) => id))).toEqual([
      "voice",
      "appearance",
    ]);
  });
});
