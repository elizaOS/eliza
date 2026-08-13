/**
 * Static source-scan guard: registered settings section files must compose
 * SettingsStack / SettingsGroup instead of a competing local card/list
 * vocabulary. Reads files off disk — no render. Remaining non-section
 * helpers stay on an explicit allowlist.
 */

import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);

/**
 * Files that are not a settings section body, or that host a custom surface
 * that is not a labelled grouped-list section. Adding a new file here is a
 * product decision; the default for a `*Section.tsx` is SettingsStack/Group.
 */
const SECTION_LAYOUT_ALLOWLIST = new Map<string, string>([
  [
    "BackgroundSettingsSection.tsx",
    "chrome-light wallpaper preview host; grouping lives in Appearance",
  ],
  [
    "PermissionsCombinedSection.tsx",
    "thin mount that delegates to PermissionsSection",
  ],
  ["VoiceSectionMount.tsx", "lazy mount wrapper, not a section body"],
  [
    "../cockpit/MyRuntimesContainer.tsx",
    "cockpit runtime switcher mount; grouping lives in MyRuntimesSection",
  ],
  ["AdvancedToggle.tsx", "compact inline disclosure control, not a section"],
  [
    "ApiKeyConfig.tsx",
    "provider-key editor embedded in ProviderSwitcher, not a section body",
  ],
  [
    "BackgroundSettingsControls.tsx",
    "wallpaper picker chrome, not a grouped settings list",
  ],
  [
    "DesktopSettingsNavigation.tsx",
    "desktop settings rail, not a section body",
  ],
  ["SettingsHubList.tsx", "mobile settings hub, not a section body"],
  ["ProviderCard.tsx", "selectable provider chip/tile, not a section body"],
  [
    "ProviderPanels.tsx",
    "provider-specific bodies hosted inside ProviderSwitcher groups",
  ],
  [
    "ProviderRoutingPanel.tsx",
    "cloud routing controls hosted inside ProviderSwitcher groups",
  ],
  [
    "SubscriptionStatus.tsx",
    "billing/checkout card, not a grouped settings list",
  ],
  [
    "VaultInventoryPanel.tsx",
    "vault credential editor is a custom multi-field form",
  ],
  [
    "VoiceProfileSection.tsx",
    "profile manager list hosted inside VoiceSection groups",
  ],
  ["VoiceTierBanner.tsx", "status banner, not a grouped settings list"],
  [
    "permission-controls.tsx",
    "row helpers hosted inside PermissionsSection groups",
  ],
  [
    "vault-tabs/LoginsTab.tsx",
    "vault login editor is a custom multi-field form",
  ],
  [
    "vault-tabs/OverviewTab.tsx",
    "vault overview editor is a custom multi-field form",
  ],
  [
    "vault-tabs/RoutingTab.tsx",
    "vault routing table is a custom multi-field form",
  ],
  ["vault-tabs/SecretsTab.tsx", "thin wrap of VaultInventoryPanel"],
]);

function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

function registeredSectionRelPaths(): string[] {
  const source = readFileSync(
    resolve(settingsRoot, "settings-sections.ts"),
    "utf8",
  );
  const matches = [
    ...source.matchAll(/import\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g),
  ];
  const relPaths = new Set<string>();
  for (const match of matches) {
    const specifier = match[1];
    const resolved = resolve(settingsRoot, specifier);
    const withExt = resolved.endsWith(".tsx") ? resolved : `${resolved}.tsx`;
    if (!statSync(withExt).isFile()) {
      throw new Error(`registered section import is not a file: ${specifier}`);
    }
    relPaths.add(posixRelative(settingsRoot, withExt));
  }
  return [...relPaths].sort();
}

describe("settings sections: use SettingsStack/Group or are allowlisted", () => {
  const files = registeredSectionRelPaths();

  it.each(files)(
    "%s uses SettingsStack/SettingsGroup, or is allowlisted",
    (relPath) => {
      const source = readFileSync(resolve(settingsRoot, relPath), "utf8");
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const usesLayout =
        code.includes("<SettingsStack") || code.includes("<SettingsGroup");
      if (usesLayout) {
        expect(SECTION_LAYOUT_ALLOWLIST.has(relPath)).toBe(false);
        return;
      }
      expect(
        SECTION_LAYOUT_ALLOWLIST.has(relPath),
        `${relPath} does not use SettingsStack/SettingsGroup. Compose the ` +
          `shared settings layout primitives, or add this file to ` +
          `SECTION_LAYOUT_ALLOWLIST with a reason.`,
      ).toBe(true);
    },
  );

  it("documents a reason for every allowlisted section-layout file that still exists", () => {
    for (const [relPath, reason] of SECTION_LAYOUT_ALLOWLIST) {
      expect(reason.trim().length).toBeGreaterThan(8);
      const full = resolve(settingsRoot, relPath);
      expect(statSync(full).isFile()).toBe(true);
    }
  });

  it("fails when a new section file skips SettingsStack/SettingsGroup", () => {
    const source = "export function NewSettingsSection() { return <div /> }";
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const usesLayout =
      code.includes("<SettingsStack") || code.includes("<SettingsGroup");
    expect(usesLayout).toBe(false);
    expect(SECTION_LAYOUT_ALLOWLIST.has("NewSettingsSection.tsx")).toBe(false);
  });
});
