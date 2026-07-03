// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
// Static import: evaluating the heavy module runs its top-level registration
// side effects, exactly as the lazy `SettingsView` does when it mounts.
import "./settings-sections";
import { SETTINGS_SECTION_META } from "./settings-section-meta";
import { getAllSettingsSections } from "./settings-section-registry";

/**
 * Guards the #10724 lazy-load seam: the eager boot barrels (`index.ts` /
 * `browser.ts`) re-export the registry accessors from the light
 * `settings-section-registry` module, so `settings-sections.ts` (the heavy
 * component graph) no longer loads at boot — it loads when the lazy
 * `SettingsView` imports it. This test proves that importing the heavy module
 * still runs its registration side effects, so every built-in section is
 * present once the Settings view mounts.
 */
describe("settings-sections registration (lazy boot seam)", () => {
  const registeredIds = new Set(
    getAllSettingsSections().map((section) => section.id),
  );

  it("registers every canonical built-in section on import", () => {
    for (const meta of SETTINGS_SECTION_META) {
      expect(
        registeredIds.has(meta.id),
        `built-in section "${meta.id}" was not registered`,
      ).toBe(true);
    }
  });

  it("also registers the registry-contributed cloud + runtime sections", () => {
    for (const id of ["cloud-overview", "cloud-agents", "my-runtimes"]) {
      expect(registeredIds.has(id), `section "${id}" missing`).toBe(true);
    }
  });
});
