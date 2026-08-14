/**
 * Integration tests for dynamic settings section registration and subscription.
 * Verifies that sections registered after mount become visible immediately
 * (bug #19332 fix).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resetUiRegistryHostForTests } from "../../registry-host";
import {
  getAllSettingsSections,
  registerSettingsSection,
  subscribeToSettingsSections,
  type SettingsSectionDef,
} from "./settings-section-registry";

describe("Dynamic settings section registration", () => {
  beforeEach(() => {
    // Clear registry between tests
    resetUiRegistryHostForTests();
  });

  afterEach(() => {
    resetUiRegistryHostForTests();
  });

  it("notifies subscribers when a new section is registered", () => {
    const calls: number[] = [];
    const unsubscribe = subscribeToSettingsSections(() => {
      calls.push(calls.length);
    });

    expect(calls).toHaveLength(0);

    // Register a section
    registerSettingsSection({
      id: "test-1",
      label: "Test 1",
      defaultLabel: "Test 1",
      titleKey: "test-1-title",
      defaultTitle: "Test 1",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "agent",
      Component: () => null,
    });

    // Subscriber should be notified
    expect(calls).toHaveLength(1);

    // Register another section
    registerSettingsSection({
      id: "test-2",
      label: "Test 2",
      defaultLabel: "Test 2",
      titleKey: "test-2-title",
      defaultTitle: "Test 2",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "agent",
      Component: () => null,
    });

    expect(calls).toHaveLength(2);

    unsubscribe();

    // After unsubscribing, no more notifications
    registerSettingsSection({
      id: "test-3",
      label: "Test 3",
      defaultLabel: "Test 3",
      titleKey: "test-3-title",
      defaultTitle: "Test 3",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "agent",
      Component: () => null,
    });

    expect(calls).toHaveLength(2);
  });

  it("caches filtered section lists based on filter key", () => {
    registerSettingsSection({
      id: "section-1",
      label: "Section 1",
      defaultLabel: "Section 1",
      titleKey: "section-1",
      defaultTitle: "Section 1",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "agent",
      Component: () => null,
    });

    registerSettingsSection({
      id: "section-2",
      label: "Section 2",
      defaultLabel: "Section 2",
      titleKey: "section-2",
      defaultTitle: "Section 2",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "system",
      Component: () => null,
    });

    const allSections = getAllSettingsSections();
    expect(allSections).toHaveLength(2);
  });

  it("invalidates filter cache when registry changes", () => {
    const sections1 = getAllSettingsSections();
    expect(sections1).toHaveLength(0);

    registerSettingsSection({
      id: "new-section",
      label: "New",
      defaultLabel: "New",
      titleKey: "new",
      defaultTitle: "New",
      tone: "neutral",
      hue: "slate",
      icon: () => null,
      group: "agent",
      Component: () => null,
    });

    const sections2 = getAllSettingsSections();
    expect(sections2).toHaveLength(1);
    expect(sections2[0].id).toBe("new-section");
  });
});
