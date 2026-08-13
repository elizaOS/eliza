/**
 * Static source-scan guard (#19142): labelled boolean settings rows must use
 * the shared SettingsSwitchRow, not re-hand-roll SettingsRow + Switch. Any new
 * production settings file that renders a raw <Switch must either adopt the
 * shared row or justify itself onto the explicit allowlist below (sites that
 * are not 1:1 labelled rows). Deterministic; reads the real source tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS_DIR = join(__dirname);

/**
 * Sites allowed to render a raw <Switch — each is not a 1:1 labelled row:
 * - settings-agent-rows.tsx: the shared row's own implementation
 * - AdvancedToggle.tsx: freestanding toggle outside a SettingsRow
 * - ConnectorsSection.tsx: switches embedded in connector cards
 * - VoiceConfigView.tsx: status-chip toggle, not a labelled row
 * - permission-controls.tsx: compound permission rows with extra controls
 */
const RAW_SWITCH_ALLOWLIST = new Set([
  "AdvancedToggle.tsx",
  "ConnectorsSection.tsx",
  "VoiceConfigView.tsx",
  "permission-controls.tsx",
  "settings-agent-rows.tsx",
]);

describe("settings switch usage (#19142)", () => {
  it("no production settings file outside the allowlist renders a raw <Switch", () => {
    const offenders = readdirSync(SETTINGS_DIR)
      .filter(
        (name) =>
          name.endsWith(".tsx") &&
          !name.includes(".test.") &&
          !name.includes(".stories.") &&
          !RAW_SWITCH_ALLOWLIST.has(name),
      )
      .filter((name) =>
        readFileSync(join(SETTINGS_DIR, name), "utf8").includes("<Switch"),
      );

    expect(offenders).toEqual([]);
  });

  it("the allowlist stays honest: every listed file exists and still uses <Switch", () => {
    for (const name of RAW_SWITCH_ALLOWLIST) {
      const source = readFileSync(join(SETTINGS_DIR, name), "utf8");
      expect(source.includes("<Switch")).toBe(true);
    }
  });
});
