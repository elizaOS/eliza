/**
 * Covers the settings-section registry: register + list back (so apps can add
 * sections), re-registering an id replaces the prior entry, and sections sort by
 * explicit order before registration sequence. Pure in-memory registry, no
 * render.
 */

import { Cog } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetUiRegistryHostForTests } from "../../registry-host";
import {
  getSettingsSection,
  getSettingsSectionRegistryVersion,
  listSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
  settingsSectionIsAvailable,
  subscribeSettingsSections,
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
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

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

  it("evaluates declarative runtime requirements without platform inference", () => {
    const portable = new Set<never>();
    const desktop = new Set(["desktop-bridge"] as const);
    const section = makeSection("desktop-only", {
      requires: ["desktop-bridge"],
    });

    expect(settingsSectionIsAvailable(section, portable)).toBe(false);
    expect(settingsSectionIsAvailable(section, desktop)).toBe(true);
    expect(settingsSectionIsAvailable(makeSection("portable"), portable)).toBe(
      true,
    );
  });

  it("notifies live consumers when a section registers", () => {
    const versions: number[] = [];
    const unsubscribe = subscribeSettingsSections(() => {
      versions.push(getSettingsSectionRegistryVersion());
    });

    registerSettingsSection(makeSection("live-plugin-section"));
    unsubscribe();
    registerSettingsSection(makeSection("after-unsubscribe"));

    expect(versions).toHaveLength(1);
    expect(versions[0]).toBeGreaterThan(0);
  });
});
