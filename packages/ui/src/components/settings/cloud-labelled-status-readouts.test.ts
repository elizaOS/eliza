/**
 * Source ratchet: cloud labelled status readouts must compose SettingsRow
 * rather than BrandCard key/value shells. Reads shipped files off disk.
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

describe("cloud labelled status readouts use SettingsRow", () => {
  it("account details labelled fields are SettingsRows", () => {
    const source = read(
      "cloud/account-security/components/account-details.tsx",
    );
    expect(source).toContain("<SettingsStack");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).toContain("Account ID");
    expect(source).toContain("Member since");
    expect(source).not.toContain("BrandCard");
    expect(source).not.toContain("CornerBrackets");
  });

  it("organization general labelled fields are SettingsRows", () => {
    const source = read("cloud/organization/organization-general-tab.tsx");
    expect(source).toContain("<SettingsStack");
    expect(source).toContain("<SettingsGroup");
    expect(source).toContain("<SettingsRow");
    expect(source).toContain("Organization name");
    expect(source).toContain("Credit balance");
    expect(source).not.toContain("BrandCard");
    expect(source).not.toContain("grid grid-cols-1 md:grid-cols-2");
  });

  it("invoice detail stays a BrandCard document, not SettingsRows", () => {
    const source = read("cloud/billing/components/invoice-detail-client.tsx");
    expect(source).toContain("BrandCard");
    expect(source).toContain("grid-cols-1 gap-6 md:grid-cols-3");
    expect(source).toContain("grid-cols-1 gap-6 sm:grid-cols-2");
    expect(source).not.toContain("<SettingsRow");
    expect(source).not.toContain("<SettingsStack");
  });
});
