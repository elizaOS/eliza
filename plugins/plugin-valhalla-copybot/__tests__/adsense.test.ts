import { describe, expect, it } from "vitest";
import { loadAdReport } from "../src/ad-report.ts";
import { adsenseSnippet, adsTxt } from "../src/adsense.ts";

describe("web ads", () => {
  it("stays off unless the owner enables a real client id", () => {
    expect(adsenseSnippet({})).toBe("");
    expect(
      adsenseSnippet({ ADSENSE_ENABLED: "false", ADSENSE_CLIENT_ID: "ca-pub-1234567890123456" })
    ).toBe("");
    expect(adsenseSnippet({ ADSENSE_ENABLED: "true", ADSENSE_CLIENT_ID: "not-an-id" })).toBe("");
    const html = adsenseSnippet({
      ADSENSE_ENABLED: "true",
      ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
      ADSENSE_SLOT: "1234567890",
    });
    expect(html).toContain("ca-pub-1234567890123456");
    expect(html).toContain('data-ad-slot="1234567890"');
    expect(html).toContain("pagead2.googlesyndication.com");
    expect(adsTxt({})).toBe("");
    expect(
      adsTxt({ ADSENSE_ENABLED: "true", ADSENSE_CLIENT_ID: "ca-pub-1234567890123456" })
    ).toContain("pub-1234567890123456");
  });

  it("does not call AdMob unless the report keys are set", async () => {
    let called = 0;
    const off = await loadAdReport({}, () => {
      called += 1;
      throw new Error("should not be called");
    });
    expect(off.enabled).toBe(false);
    expect(called).toBe(0);
    const bad = await loadAdReport({
      ADMOB_ACCOUNT_ID: "not-a-pub",
      ADMOB_CLIENT_ID: "client",
      ADMOB_CLIENT_SECRET: "secret",
      ADMOB_REFRESH_TOKEN: "token",
    });
    expect(bad.enabled).toBe(true);
    expect(bad.error).toMatch(/not valid/);
    expect(JSON.stringify(bad)).not.toContain("secret");
  });
});
