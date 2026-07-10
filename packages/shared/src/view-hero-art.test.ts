/**
 * Unit tests for the deterministic view hero-art generator (view-hero-art.ts):
 * SVG rendering, stable per-key hue derivation that avoids the blue band,
 * keyword/tag/icon-name to glyph mapping, XML escaping, and per-slug element-id
 * namespacing. Pure functions, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  generateViewHeroSvgFor,
  hueForViewKey,
  pickViewHeroIcon,
  renderViewHeroSvg,
  VIEW_HERO_ICONS,
  type ViewHeroIconKind,
} from "./view-hero-art.js";

describe("view-hero-art", () => {
  it("renders a deterministic, valid square SVG", () => {
    const a = generateViewHeroSvgFor({ id: "calendar", label: "Calendar" });
    const b = generateViewHeroSvgFor({ id: "calendar", label: "Calendar" });
    expect(a).toBe(b); // deterministic
    expect(a.startsWith("<svg")).toBe(true);
    expect(a).toContain('viewBox="0 0 1024 1024"');
    expect(a.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("embeds the label and escapes XML-significant characters", () => {
    const svg = generateViewHeroSvgFor({ label: "Tom & <Jerry>" });
    expect(svg).toContain("Tom &amp; &lt;Jerry&gt;");
    expect(svg).not.toContain("<Jerry>");
  });

  it("never picks a hue in the pure-blue band (~200–260)", () => {
    const keys = [
      "calendar",
      "wallet",
      "relationships",
      "blue",
      "blueprint",
      "ocean",
      "sky",
      "navy view",
      "azure dashboard",
      "a",
      "zzzzz",
      "plugin-foo-bar",
    ];
    for (const key of keys) {
      const hue = hueForViewKey(key);
      expect(hue >= 200 && hue < 260).toBe(false);
    }
  });

  it("picks a stable hue for the same key", () => {
    expect(hueForViewKey("calendar")).toBe(hueForViewKey("calendar"));
  });

  it("maps keywords to the right icon glyph, defaulting to the grid", () => {
    const cases: Array<[string, ViewHeroIconKind]> = [
      ["calendar", "calendar"],
      ["health", "health"],
      ["wallet", "finances"],
      ["relationships", "vectorBrowser"],
      ["my messages", "messages"],
      ["todo list", "todos"],
      ["focus mode", "focus"],
      ["something-unknown", "views"],
    ];
    for (const [label, expected] of cases) {
      expect(pickViewHeroIcon({ label })).toBe(expected);
    }
  });

  it("does not retain the removed Social Alpha glyph or keyword mapping", () => {
    expect("socialAlpha" in VIEW_HERO_ICONS).toBe(false);
    expect(pickViewHeroIcon({ label: "Social Alpha leaderboard feed" })).toBe(
      "views",
    );
  });

  it("uses the Lucide icon name and tags as keyword hints", () => {
    expect(pickViewHeroIcon({ label: "Money Tracker", icon: "Wallet" })).toBe(
      "finances",
    );
    expect(
      pickViewHeroIcon({ label: "People", tags: ["graph", "entities"] }),
    ).toBe("vectorBrowser");
  });

  it("renders every catalogued icon glyph without throwing", () => {
    for (const key of Object.keys(VIEW_HERO_ICONS) as ViewHeroIconKind[]) {
      const svg = renderViewHeroSvg({
        id: key,
        hue: hueForViewKey(key),
        iconSvg: VIEW_HERO_ICONS[key],
        label: key,
      });
      expect(svg).toContain("<svg");
    }
  });

  it("namespaces SVG element ids from the slug so two heroes don't collide", () => {
    const svg = generateViewHeroSvgFor({ id: "My View!", label: "My View" });
    // Slugified id used in gradient ids.
    expect(svg).toContain("bg-my-view");
  });
});
