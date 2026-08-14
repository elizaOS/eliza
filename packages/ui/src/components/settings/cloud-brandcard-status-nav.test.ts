/**
 * Source ratchet: leftover cloud BrandCard status/nav chrome must compose
 * SettingsStack / SettingsGroup / SettingsRow. Reads shipped files off disk.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsRoot = dirname(fileURLToPath(import.meta.url));
const uiSrc = join(settingsRoot, "../..");

function read(rel: string): string {
  return readFileSync(join(uiSrc, rel), "utf8");
}

describe("cloud BrandCard status/nav leftovers use Settings primitives", () => {
  it("recent audit events are a status SettingsRow, not a BrandCard", () => {
    const source = read(
      "cloud/account-security/components/recent-audit-events.tsx",
    );
    expect(source).toContain("<SettingsStack");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).toContain(
      "Audit log reading is unavailable on this server.",
    );
    expect(source).not.toContain("BrandCard");
    expect(source).not.toContain("CornerBrackets");
  });

  it("plugin permissions nav is a SettingsRow hash link", () => {
    const source = read(
      "cloud/account-security/components/plugin-permissions-link.tsx",
    );
    expect(source).toContain("<SettingsRow");
    expect(source).toContain('href="#cloud-plugin-grants"');
    expect(source).not.toContain("BrandCard");
  });

  it("security surface mounts PluginPermissionsLink instead of a nav chip", () => {
    const source = read("cloud/account-security/SecuritySurface.tsx");
    expect(source).toContain("<PluginPermissionsLink");
    expect(source).not.toContain("Plugin permissions →");
    expect(source).not.toMatch(/<nav className="flex flex-wrap gap-2/);
  });

  it("pay-as-you-go wraps the existing switch in SettingsStack/Group", () => {
    const source = read("cloud/billing/components/pay-as-you-go-card.tsx");
    expect(source).toContain("<SettingsStack");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("SettingsSwitchRow");
    expect(source).toContain('agentId="cloud-billing-pay-as-you-go"');
    expect(source).not.toContain("BrandCard");
    expect(source).not.toContain("CornerBrackets");
  });

  it("MFA status panel is SettingsRows, not a BrandCard", () => {
    const source = read("cloud/account-security/components/mfa-panel.tsx");
    expect(source).toContain("<SettingsStack");
    expect(source).toContain("<SettingsRow");
    expect(source).toContain("MFA enrollment is unavailable on this server.");
    expect(source).not.toContain("BrandCard");
    expect(source).not.toContain("CornerBrackets");
  });

  it("organization empty state is a SettingsRow", () => {
    const source = read("cloud/organization/organization-tab.tsx");
    expect(source).toContain('data-testid="cloud-organization-empty"');
    expect(source).toContain("No organization found");
    expect(source).toMatch(
      /if \(!user\.organization\) \{[\s\S]*<SettingsRow label="No organization found"/,
    );
  });
});
