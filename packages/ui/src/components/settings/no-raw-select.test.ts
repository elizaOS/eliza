/**
 * Static source-scan guard: labelled settings selects must use
 * SettingsSelectRow instead of a hand-rolled SettingsRow/Label + Select.
 * Reads files off disk — no render. Remaining raw Select sites are an
 * explicit allowlist for compact/custom forms.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Files that still own a raw `<Select` because they are not a 1:1 labelled
 * settings row. Adding a new file here is a product decision; the default is
 * `SettingsSelectRow`.
 */
const RAW_SELECT_ALLOWLIST = new Map<string, string>([
  [
    "settings-agent-rows.tsx",
    "canonical SettingsSelectRow primitive; it is the one allowed Select owner",
  ],
  [
    "VaultInventoryPanel.tsx",
    "vault add-form category picker lives in a compact custom form, not a settings row",
  ],
  [
    "VoiceProfileSection.tsx",
    "inline relationship chip on the profile row, not a labelled settings select",
  ],
  [
    "vault-tabs/RoutingTab.tsx",
    "routing table cells and default-profile compact picker, not labelled settings rows",
  ],
]);

function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

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

describe("settings controls: no raw <Select outside the allowlist", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => posixRelative(settingsRoot, file)))(
    "%s uses SettingsSelectRow instead of a raw <Select, or is allowlisted",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const hasRawSelect = source.includes("<Select");
      if (!hasRawSelect) {
        expect(RAW_SELECT_ALLOWLIST.has(relPath)).toBe(false);
        return;
      }
      expect(
        RAW_SELECT_ALLOWLIST.has(relPath),
        `${relPath} hand-rolls a raw <Select. Use SettingsSelectRow from ` +
          `./settings-agent-rows for labelled settings selects. If this file ` +
          `is not a settings select row, add it to RAW_SELECT_ALLOWLIST with a reason.`,
      ).toBe(true);
    },
  );

  it("documents a reason for every allowlisted raw Select file", () => {
    for (const [relPath, reason] of RAW_SELECT_ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(8);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(
        source.includes("<Select"),
        `${relPath} is allowlisted but no longer contains <Select; remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
