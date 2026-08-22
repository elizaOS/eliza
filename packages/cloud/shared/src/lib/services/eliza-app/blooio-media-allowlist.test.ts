// Pins the canonical Blooio media-URL allowlist: https-only, Blooio-owned
// hosts (including subdomains), and rejection of lookalike/suffix-attack
// hosts. Pure deterministic predicate — no network or mocks.
import { describe, expect, test } from "bun:test";
import { ALLOWED_BLOOIO_MEDIA_DOMAINS, isAllowedBlooioMediaUrl } from "./blooio-media-allowlist";

describe("isAllowedBlooioMediaUrl", () => {
  test("accepts https URLs on every allowlisted domain and its subdomains", () => {
    for (const domain of ALLOWED_BLOOIO_MEDIA_DOMAINS) {
      expect(isAllowedBlooioMediaUrl(`https://${domain}/files/a.jpg`)).toBe(true);
      expect(isAllowedBlooioMediaUrl(`https://cdn.${domain}/a.png`)).toBe(true);
    }
  });

  test("rejects non-https schemes even on allowlisted hosts", () => {
    expect(isAllowedBlooioMediaUrl("http://media.blooio.com/a.jpg")).toBe(false);
    expect(isAllowedBlooioMediaUrl("ftp://media.blooio.com/a.jpg")).toBe(false);
  });

  test("rejects lookalike and suffix-attack hosts", () => {
    expect(isAllowedBlooioMediaUrl("https://notblooio.com/a.jpg")).toBe(false);
    expect(isAllowedBlooioMediaUrl("https://blooio.com.evil.com/a.jpg")).toBe(false);
    expect(isAllowedBlooioMediaUrl("https://evilblooio.com/a.jpg")).toBe(false);
    expect(isAllowedBlooioMediaUrl("https://example.com/blooio.com")).toBe(false);
  });

  test("rejects unparsable input instead of defaulting", () => {
    expect(isAllowedBlooioMediaUrl("")).toBe(false);
    expect(isAllowedBlooioMediaUrl("not a url")).toBe(false);
    expect(isAllowedBlooioMediaUrl("//media.blooio.com/a.jpg")).toBe(false);
  });
});
