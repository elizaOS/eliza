import { describe, expect, it } from "vitest";
import { adsenseSnippet } from "../src/adsense.ts";

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
  });
});
