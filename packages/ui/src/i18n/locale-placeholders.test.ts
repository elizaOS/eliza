/**
 * A translation may legitimately drop a placeholder the English string has —
 * `{{plural}}` is meaningless in Japanese, Korean, Chinese and Vietnamese, and
 * several locales spell the product name out instead of interpolating
 * `{{appName}}`. The reverse is never right: a placeholder that appears only in
 * a translation names a variable no caller was asked to supply, and
 * `interpolate` in ./index.ts substitutes the empty string for it (or leaves
 * the `{{…}}` literal when the call site passes no vars at all).
 *
 * That shipped: `computeruseapprovaloverlay.ModeLine` rendered
 * `模式：auto · 工具：` for zh-CN — a dangling label with nothing after it —
 * and `charactereditor.ConversationCount` rendered `" usapan"` for tl, dropping
 * the count the translator meant to show.
 */

import { describe, expect, it } from "vitest";
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import pt from "./locales/pt.json" with { type: "json" };
import tl from "./locales/tl.json" with { type: "json" };
import vi from "./locales/vi.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };

const TRANSLATIONS: Record<string, Record<string, unknown>> = {
  es,
  ja,
  ko,
  pt,
  tl,
  vi,
  "zh-CN": zhCN,
};

// Mirrors the pattern `interpolate` uses in ./index.ts.
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function placeholders(value: string): Set<string> {
  return new Set(Array.from(value.matchAll(PLACEHOLDER), (m) => m[1]));
}

const english = en as Record<string, unknown>;

describe("locale placeholders", () => {
  it.each(Object.keys(TRANSLATIONS))(
    "%s introduces no placeholder the English string lacks",
    (locale) => {
      const offenders: string[] = [];
      for (const [key, value] of Object.entries(TRANSLATIONS[locale])) {
        const source = english[key];
        if (typeof value !== "string" || typeof source !== "string") continue;
        const extra = [...placeholders(value)].filter(
          (name) => !placeholders(source).has(name),
        );
        if (extra.length > 0) {
          offenders.push(`${key}: {{${extra.join("}}, {{")}}} — ${value}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it("covers every shipped locale except the English source", () => {
    // Guards against a new locale being added without joining this check.
    expect(Object.keys(TRANSLATIONS).sort()).toEqual([
      "es",
      "ja",
      "ko",
      "pt",
      "tl",
      "vi",
      "zh-CN",
    ]);
  });
});
