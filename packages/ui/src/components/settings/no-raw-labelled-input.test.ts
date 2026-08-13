/**
 * Static source-scan guard: labelled text/password settings fields must use
 * SettingsInputRow instead of a hand-rolled Label + Input pair. Reads files
 * off disk — no render. Remaining raw Input sites are an explicit allowlist.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Files that still own a raw `<Input` because they are not a 1:1 labelled
 * text/password settings field. Adding a new file here is a product decision;
 * the default is `SettingsInputRow`.
 */
const RAW_INPUT_ALLOWLIST = new Map<string, string>([
  [
    "AdvancedSection.tsx",
    "radio list of backup files, not a labelled text field",
  ],
  [
    "BackgroundSettingsControls.tsx",
    "hidden file picker for wallpaper upload, not a labelled text field",
  ],
  [
    "CloudAgentsSection.tsx",
    "inline rename and create-name fields sit beside action buttons",
  ],
  [
    "SubscriptionStatus.tsx",
    "billing/checkout form fields live in a custom card, not a settings row",
  ],
  [
    "VaultInventoryPanel.tsx",
    "vault credential editor is a custom multi-field form, not a settings row",
  ],
  [
    "VoiceConfigView.tsx",
    "compact wake-word and device fields inside a custom status chip",
  ],
  [
    "VoiceProfileSection.tsx",
    "inline rename field; remaining Label usages are merge/sample checkboxes",
  ],
  [
    "VoiceSection.tsx",
    "checkbox consent controls, not labelled text/password fields",
  ],
  [
    "vault-tabs/LoginsTab.tsx",
    "vault login editor is a custom multi-field form, not a settings row",
  ],
  [
    "vault-tabs/OverviewTab.tsx",
    "vault overview editor is a custom multi-field form, not a settings row",
  ],
  [
    "vault-tabs/RoutingTab.tsx",
    "vault routing editor is a custom multi-field form, not a settings row",
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

describe("settings controls: no raw labelled <Input outside the allowlist", () => {
  const files = listTsxFiles(settingsRoot);

  it.each(files.map((file) => posixRelative(settingsRoot, file)))(
    "%s uses SettingsInputRow instead of a raw <Input, or is allowlisted",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const hasRawInput = source.includes("<Input");
      if (!hasRawInput) {
        expect(RAW_INPUT_ALLOWLIST.has(relPath)).toBe(false);
        return;
      }
      expect(
        RAW_INPUT_ALLOWLIST.has(relPath),
        `${relPath} hand-rolls a raw <Input. Use SettingsInputRow from ` +
          `./settings-agent-rows for labelled text/password settings. If this ` +
          `file is not a settings text field, add it to RAW_INPUT_ALLOWLIST ` +
          `with a reason.`,
      ).toBe(true);
    },
  );

  it("documents a reason for every allowlisted raw Input file", () => {
    for (const [relPath, reason] of RAW_INPUT_ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(8);
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      expect(
        source.includes("<Input"),
        `${relPath} is allowlisted but no longer contains <Input; remove it from the allowlist`,
      ).toBe(true);
    }
  });
});
