/**
 * Static source-scan guard: boolean settings rows must use SettingsSwitchRow
 * instead of a hand-rolled SettingsRow + Switch. Reads files off disk — no
 * render. Remaining raw Switch sites are an explicit, documented allowlist.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Files that still own a raw `<Switch` because they are not a 1:1 labelled
 * settings row. Adding a new file here is a product decision; the default is
 * `SettingsSwitchRow` so the toggle is themed, 44px-touch, and agent-addressable.
 */
const RAW_SWITCH_ALLOWLIST = new Map<string, string>([
  [
    "settings-agent-rows.tsx",
    "canonical SettingsSwitchRow primitive; it is the one allowed Switch owner",
  ],
  [
    "AdvancedToggle.tsx",
    "compact inline disclosure control, not a labelled settings row",
  ],
  [
    "ConnectorsSection.tsx",
    "standalone enable switch on a custom connector card, not a SettingsRow",
  ],
  [
    "VoiceConfigView.tsx",
    "compact enable switch inside a custom status chip, not a SettingsRow",
  ],
  [
    "permission-controls.tsx",
    "compound permission rows mix badges with Switch or Button trailing controls",
  ],
]);

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsxFiles(full));
    } else if (
      name.endsWith(".tsx") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".stories.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("settings controls: no raw <Switch outside the allowlist", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => relative(settingsRoot, file)))(
    "%s uses SettingsSwitchRow instead of a raw <Switch, or is allowlisted",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const hasRawSwitch = source.includes("<Switch");
      if (!hasRawSwitch) {
        expect(RAW_SWITCH_ALLOWLIST.has(relPath)).toBe(false);
        return;
      }
      expect(
        RAW_SWITCH_ALLOWLIST.has(relPath),
        `${relPath} hand-rolls a raw <Switch. Use SettingsSwitchRow from ` +
          `./settings-agent-rows for labelled boolean settings. If this file is ` +
          `not a settings row, add it to RAW_SWITCH_ALLOWLIST with a reason.`,
      ).toBe(true);
    },
  );

  it("documents a reason for every allowlisted raw Switch file", () => {
    for (const [relPath, reason] of RAW_SWITCH_ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(8);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(
        source.includes("<Switch"),
        `${relPath} is allowlisted but no longer contains <Switch; remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
