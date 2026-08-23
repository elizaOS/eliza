/**
 * Exercises affiliate theme resolution against untrusted identifiers. The
 * theme registry is a plain object reached from a URL `source` parameter and
 * from character metadata, so lookup must resolve only registry-owned keys:
 * inherited `Object.prototype` members must never be mistaken for a theme.
 * Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  AFFILIATE_THEMES,
  type AffiliateTheme,
  getAffiliateIdFromCharacter,
  getAffiliateIds,
  getAffiliateTheme,
  getThemeCSSVariables,
  hasAffiliateTheme,
  resolveCharacterTheme,
} from "./affiliate-themes";

/** Keys every plain object inherits but no registry actually declares. */
const INHERITED_KEYS = [
  "toString",
  "valueOf",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
] as const;

function isAffiliateTheme(value: unknown): value is AffiliateTheme {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AffiliateTheme>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.colors === "object" &&
    candidate.colors !== null
  );
}

describe("getAffiliateTheme", () => {
  test("returns the default theme for the default id", () => {
    expect(getAffiliateTheme("default").id).toBe("default");
  });

  test("falls back to default for nullish ids", () => {
    expect(getAffiliateTheme(undefined).id).toBe("default");
    expect(getAffiliateTheme(null).id).toBe("default");
    expect(getAffiliateTheme("").id).toBe("default");
  });

  test("falls back to default for unregistered ids", () => {
    expect(getAffiliateTheme("no-such-affiliate").id).toBe("default");
  });

  test.each(INHERITED_KEYS)("falls back to default for inherited key %s", (key) => {
    expect(getAffiliateTheme(key).id).toBe("default");
  });

  test("always returns a structurally valid theme", () => {
    for (const key of [...INHERITED_KEYS, "default", "nope", ""]) {
      expect(isAffiliateTheme(getAffiliateTheme(key))).toBe(true);
    }
  });
});

describe("hasAffiliateTheme", () => {
  test("is true only for registered ids", () => {
    expect(hasAffiliateTheme("default")).toBe(true);
    expect(hasAffiliateTheme("no-such-affiliate")).toBe(false);
  });

  test.each(INHERITED_KEYS)("is false for inherited key %s", (key) => {
    expect(hasAffiliateTheme(key)).toBe(false);
  });

  test("agrees with the enumerated id list", () => {
    const ids = getAffiliateIds();
    for (const id of ids) expect(hasAffiliateTheme(id)).toBe(true);
    for (const key of INHERITED_KEYS) expect(ids).not.toContain(key);
  });

  test("implies getAffiliateTheme returns that exact theme", () => {
    for (const id of getAffiliateIds()) {
      expect(getAffiliateTheme(id)).toBe(AFFILIATE_THEMES[id]);
    }
  });
});

describe("resolveCharacterTheme", () => {
  test("prefers a registered source over character metadata", () => {
    const theme = resolveCharacterTheme("default", {
      affiliate: { affiliateId: "unregistered" },
    });
    expect(theme.id).toBe("default");
  });

  test("falls back to the default theme with no inputs", () => {
    expect(resolveCharacterTheme(null, null).id).toBe("default");
    expect(resolveCharacterTheme(undefined, undefined).id).toBe("default");
  });

  test("ignores an unregistered source", () => {
    expect(resolveCharacterTheme("nope", null).id).toBe("default");
  });

  test.each(INHERITED_KEYS)("ignores inherited key %s supplied as the source param", (key) => {
    const theme = resolveCharacterTheme(key, null);
    expect(isAffiliateTheme(theme)).toBe(true);
    expect(theme.id).toBe("default");
  });

  test.each(INHERITED_KEYS)("ignores inherited key %s supplied via character metadata", (key) => {
    const theme = resolveCharacterTheme(null, {
      affiliate: { affiliateId: key },
    });
    expect(isAffiliateTheme(theme)).toBe(true);
    expect(theme.id).toBe("default");
  });

  test("resolved theme always yields usable CSS variables", () => {
    for (const key of [...INHERITED_KEYS, "default", "nope"]) {
      const vars = getThemeCSSVariables(resolveCharacterTheme(key, null));
      expect(typeof vars["--theme-primary"]).toBe("string");
      expect(vars["--theme-primary"].length).toBeGreaterThan(0);
    }
  });
});

describe("getAffiliateIdFromCharacter", () => {
  test("reads the nested affiliate id", () => {
    expect(getAffiliateIdFromCharacter({ affiliate: { affiliateId: "abc" } })).toBe("abc");
  });

  test("returns undefined for missing or empty metadata", () => {
    expect(getAffiliateIdFromCharacter(null)).toBeUndefined();
    expect(getAffiliateIdFromCharacter(undefined)).toBeUndefined();
    expect(getAffiliateIdFromCharacter({})).toBeUndefined();
    expect(getAffiliateIdFromCharacter({ affiliate: {} })).toBeUndefined();
  });
});

describe("getThemeCSSVariables", () => {
  test("maps every colour slot onto a --theme-* custom property", () => {
    const theme = getAffiliateTheme("default");
    expect(getThemeCSSVariables(theme)).toEqual({
      "--theme-primary": theme.colors.primary,
      "--theme-primary-light": theme.colors.primaryLight,
      "--theme-accent": theme.colors.accent,
      "--theme-background": theme.colors.background,
      "--theme-gradient-from": theme.colors.gradientFrom,
      "--theme-gradient-to": theme.colors.gradientTo,
    });
  });

  test("every declared theme exposes non-empty RGB triplets", () => {
    for (const id of getAffiliateIds()) {
      for (const value of Object.values(getThemeCSSVariables(AFFILIATE_THEMES[id]))) {
        expect(value).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
      }
    }
  });
});
