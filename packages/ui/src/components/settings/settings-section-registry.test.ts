import { Cog } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  getSettingsSection,
  listSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
} from "./settings-section-registry";

function makeSection(
  id: string,
  overrides: Partial<SettingsSectionDef> = {},
): SettingsSectionDef {
  return {
    id,
    label: `settings.sections.${id}.label`,
    defaultLabel: id,
    icon: Cog,
    tone: "neutral",
    hue: "slate",
    group: "system",
    titleKey: `settings.sections.${id}.label`,
    defaultTitle: id,
    Component: () => null,
    ...overrides,
  };
}

describe("settings-section-registry", () => {
  it("registers a section and lists it back (apps can add settings)", () => {
    registerSettingsSection(makeSection("test-plugin-section"));
    const ids = listSettingsSections().map((s) => s.id);
    expect(ids).toContain("test-plugin-section");
    expect(getSettingsSection("test-plugin-section")?.defaultLabel).toBe(
      "test-plugin-section",
    );
  });

  it("re-registering the same id replaces the prior entry", () => {
    registerSettingsSection(makeSection("dupe", { defaultLabel: "first" }));
    registerSettingsSection(makeSection("dupe", { defaultLabel: "second" }));
    const matches = listSettingsSections().filter((s) => s.id === "dupe");
    expect(matches).toHaveLength(1);
    expect(matches[0].defaultLabel).toBe("second");
  });

  it("sorts by explicit order before registration sequence", () => {
    registerSettingsSection(makeSection("order-late", { order: 9000 }));
    registerSettingsSection(makeSection("order-early", { order: 1 }));
    const ordered = listSettingsSections().map((s) => s.id);
    expect(ordered.indexOf("order-early")).toBeLessThan(
      ordered.indexOf("order-late"),
    );
  });
});
