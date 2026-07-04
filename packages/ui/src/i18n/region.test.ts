/**
 * Unit coverage for Accept-Language / region language resolution. Pure
 * functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  languageFromAcceptLanguage,
  languageFromRegion,
  resolveServerLanguage,
} from "./region";

describe("languageFromAcceptLanguage", () => {
  it("picks a supported language", () => {
    expect(languageFromAcceptLanguage("ja")).toBe("ja");
    expect(languageFromAcceptLanguage("es-MX, en;q=0.5")).toBe("es");
  });

  it("ranks by q-value", () => {
    expect(languageFromAcceptLanguage("ko;q=0.3, ja;q=0.9")).toBe("ja");
  });

  it("skips unsupported tags and wildcards", () => {
    expect(languageFromAcceptLanguage("de, *;q=0.5")).toBeNull();
    expect(languageFromAcceptLanguage("de-AT, pt;q=0.4")).toBe("pt");
  });

  it("excludes q=0 tags entirely (RFC 9110: not acceptable)", () => {
    // A lone rejected tag must yield null, not the rejected language.
    expect(languageFromAcceptLanguage("ja;q=0")).toBeNull();
    expect(languageFromAcceptLanguage("es;q=0, de")).toBeNull();
    // A rejected tag never outranks an accepted one.
    expect(languageFromAcceptLanguage("ko;q=0, ja;q=0.8")).toBe("ja");
  });

  it("returns null for empty/absent headers", () => {
    expect(languageFromAcceptLanguage("")).toBeNull();
    expect(languageFromAcceptLanguage(null)).toBeNull();
    expect(languageFromAcceptLanguage(undefined)).toBeNull();
  });
});

describe("languageFromRegion", () => {
  it("maps a country code case-insensitively", () => {
    expect(languageFromRegion("br")).toBe("pt");
    expect(languageFromRegion("KR")).toBe("ko");
  });

  it("returns null for unmapped or missing codes", () => {
    expect(languageFromRegion("DE")).toBeNull();
    expect(languageFromRegion(null)).toBeNull();
  });
});

describe("resolveServerLanguage", () => {
  it("prefers Accept-Language over region", () => {
    expect(resolveServerLanguage({ acceptLanguage: "ja", country: "BR" })).toBe(
      "ja",
    );
  });

  it("falls through to region when every listed language is rejected", () => {
    // `ja;q=0` used to resolve to "ja" and shadow the region signal.
    expect(
      resolveServerLanguage({ acceptLanguage: "ja;q=0", country: "BR" }),
    ).toBe("pt");
  });

  it("returns null when neither signal maps to a supported language", () => {
    expect(
      resolveServerLanguage({ acceptLanguage: "de", country: "FR" }),
    ).toBeNull();
  });
});
