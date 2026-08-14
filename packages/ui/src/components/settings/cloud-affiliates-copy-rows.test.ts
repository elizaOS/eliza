/**
 * Source ratchet: affiliates invite and affiliate URLs use SettingsRow + copy
 * control. Markup stays SettingsInputRow. BrandCard chrome stays. Reads the
 * shipped file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string): string {
  return readFileSync(join(uiSrc, rel), "utf8");
}

describe("affiliates copyable URL rows", () => {
  it("routes invite and affiliate links through SettingsRow copy controls", () => {
    const source = read(
      "cloud/monetization/affiliates/AffiliatesPageClient.tsx",
    );
    expect(source).toContain("<SettingsRow");
    expect(source).toContain('testId="cloud-affiliates-copy-invite"');
    expect(source).toContain('testId="cloud-affiliates-copy-affiliate"');
    expect(source).toContain("Copy link");
    expect(source).toContain("break-all");
    expect(source).not.toContain(
      "overflow-hidden text-ellipsis whitespace-nowrap",
    );
    expect(source).toContain("<SettingsInputRow");
    expect(source).toContain('agentId="cloud-affiliates-markup-percent"');
    expect(source).toContain("BrandCard");
    expect(source).toContain("cURL Example");
    expect(source).toContain("Affiliate Program");
  });
});
