/**
 * Source ratchet: leftover labelled dashboard rows must compose SettingsRow
 * rather than hand-rolled flex/grid shells. Reads shipped files off disk.
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

describe("labelled settings-row shells use SettingsRow", () => {
  it("privacy DSR cards are SettingsRows and keep the delete trigger", () => {
    const source = read("cloud/account-security/components/privacy-panel.tsx");
    expect(source).toContain("<SettingsRow");
    expect(source).toContain("Download my data");
    expect(source).toContain('data-testid="delete-account-trigger"');
    expect(source).not.toContain("BrandCard");
  });

  it("local session and access-info rows use SettingsRow", () => {
    const source = read("components/settings/SecuritySettingsSection.tsx");
    expect(source).toMatch(/function AccessInfoRow[\s\S]*<SettingsRow/);
    expect(source).toMatch(/const SessionRow[\s\S]*<SettingsRow/);
    expect(source).toContain("security-session-revoke-");
  });

  it("streaming permission rows use SettingsRow", () => {
    const source = read("components/permissions/StreamingPermissions.tsx");
    expect(source).toContain("<SettingsRow");
    expect(source).not.toContain("flex items-center gap-3 py-2.5");
  });

  it("locked model provider readout uses SettingsRow", () => {
    const source = read("components/settings/ModelConfigurationPanel.tsx");
    expect(source).toMatch(
      /group\.providerLocked \?[\s\S]*<SettingsRow[\s\S]*modelconfig\.providerFollowsActive/,
    );
  });
});
