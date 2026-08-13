/**
 * Static source-scan guard: registered settings section files must compose
 * SettingsStack / SettingsGroup instead of a competing local card/list
 * vocabulary. Reads files off disk — no render. Remaining non-section
 * helpers stay on an explicit allowlist.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  [
    "../../cloud/connectors/index.ts",
    "cloud connectors adapter; grouping lives in CloudConnectorsSettingsBody",
  ],
  [
    "../../cloud/settings/sections.tsx",
    "cloud settings adapters; grouping lives in domain bodies",
  ],
  [
    "../../cloud/mcps/McpsSection.tsx",
    "cloud MCP adapter; grouping lives in the MCP surface",
  ],
  [
    "../../cloud/mcps/McpsRoute.tsx",
    "cloud MCP route wrapper, not a settings section body",
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

const uiSrcRoot = resolve(settingsRoot, "../../");

function posixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith("__")) {
        continue;
      }
      out.push(...listSourceFiles(full));
      continue;
    }
    if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".stories.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function resolveExistingFile(
  baseDir: string,
  specifier: string,
): string | null {
  const resolved = resolve(baseDir, specifier);
  const candidates =
    resolved.endsWith(".ts") || resolved.endsWith(".tsx")
      ? [resolved]
      : [
          `${resolved}.tsx`,
          `${resolved}.ts`,
          join(resolved, "index.ts"),
          join(resolved, "index.tsx"),
        ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function importedBindingFiles(file: string, identifier: string): string[] {
  const source = readFileSync(file, "utf8");
  const files = new Set<string>();
  const fromDir = dirname(file);
  for (const match of source.matchAll(
    new RegExp(
      `import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*["'](\\.?\\.?\\/[^"']+)["']`,
      "g",
    ),
  )) {
    const resolved = resolveExistingFile(fromDir, match[1]);
    if (resolved) files.add(resolved);
  }
  for (const match of source.matchAll(
    new RegExp(
      `const\\s+${identifier}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\(\\s*["'](\\.?\\.?\\/[^"']+)["']`,
      "g",
    ),
  )) {
    const resolved = resolveExistingFile(fromDir, match[1]);
    if (resolved) files.add(resolved);
  }
  if (files.size === 0) {
    if (
      new RegExp(
        `(?:export\\s+)?(?:function|const|class)\\s+${identifier}\\b`,
      ).test(source)
    ) {
      files.add(file);
    }
  }
  return [...files];
}

function registeredSectionRelPaths(): string[] {
  const relPaths = new Set<string>();
  for (const file of listSourceFiles(uiSrcRoot)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("registerSettingsSection(")) continue;
    for (const match of source.matchAll(/Component:\s*([A-Za-z0-9_]+)/g)) {
      const identifier = match[1];
      if (identifier === "Component" || identifier === "def") continue;
      for (const resolved of importedBindingFiles(file, identifier)) {
        relPaths.add(posixRelative(settingsRoot, resolved));
      }
    }
    for (const match of source.matchAll(
      /import\(\s*["'](\.?\.?\/[^"']+)["']\s*\)/g,
    )) {
      const resolved = resolveExistingFile(dirname(file), match[1]);
      if (resolved) relPaths.add(posixRelative(settingsRoot, resolved));
    }
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

  it("includes late-registered cloud section adapters in the registry scan", () => {
    expect(files).toContain("../../cloud/connectors/index.ts");
    expect(files).toContain("../../cloud/settings/sections.tsx");
    expect(files).toContain("../../cloud/mcps/McpsSection.tsx");
  });

  it("fails when a newly registered file skips SettingsStack/SettingsGroup", () => {
    const source = "export function NewSettingsSection() { return <div /> }";
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const usesLayout =
      code.includes("<SettingsStack") || code.includes("<SettingsGroup");
    expect(usesLayout).toBe(false);
    expect(SECTION_LAYOUT_ALLOWLIST.has("NewSettingsSection.tsx")).toBe(false);
    expect(files.includes("NewSettingsSection.tsx")).toBe(false);
  });
});
