/**
 * Verifies the NuPhy-to-Eliza Cloud text bridge keeps lifted section text
 * readable without mutating the shared fill tokens used by the Settings shell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NUPHY_SCOPE_CSS = readFileSync(
  fileURLToPath(new URL("../../../styles/nuphy-scope.css", import.meta.url)),
  "utf8",
);

type Rgb = readonly [number, number, number];

function hexToRgb(value: string): Rgb {
  return [1, 3, 5].map((index) =>
    Number.parseInt(value.slice(index, index + 2), 16),
  ) as unknown as Rgb;
}

function rgbaOver(value: string, background: Rgb): Rgb {
  const match = value.match(
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/,
  );
  if (!match) throw new Error(`Unsupported rgba color: ${value}`);
  const alpha = Number(match[4]);
  return [1, 2, 3].map(
    (index) =>
      Number(match[index]) * alpha + background[index - 1] * (1 - alpha),
  ) as unknown as Rgb;
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: Rgb, background: Rgb): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function ruleBody(selector: string): string {
  const start = NUPHY_SCOPE_CSS.indexOf(selector);
  if (start < 0) throw new Error(`Missing selector: ${selector}`);
  const open = NUPHY_SCOPE_CSS.indexOf("{", start);
  const close = NUPHY_SCOPE_CSS.indexOf("}", open);
  return NUPHY_SCOPE_CSS.slice(open + 1, close);
}

function token(rule: string, name: string): string {
  const match = rule.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
}

describe("Eliza Cloud section text bridge", () => {
  it.each([
    {
      selector: ".nuphy-scope {",
      surfaces: ["#ebebeb", "#ffffff"],
      expectedMutedFill: "rgba(29, 29, 31, 0.04)",
      expectedAccentFill: "rgba(29, 29, 31, 0.04)",
    },
    {
      selector: ".nuphy-scope.nuphy-dark {",
      surfaces: ["#141414", "#1e1e1e", "#262626"],
      expectedMutedFill: "rgba(255, 255, 255, 0.05)",
      expectedAccentFill: "rgba(255, 255, 255, 0.06)",
    },
  ])(
    "keeps readable inherited text colors and unchanged NuPhy fills in $selector",
    ({ selector, surfaces, expectedMutedFill, expectedAccentFill }) => {
      const rule = ruleBody(selector);
      const mutedText = token(rule, "--cloud-section-muted-fg");
      const accentText = token(rule, "--cloud-section-accent-fg");

      expect(token(rule, "--muted")).toBe(expectedMutedFill);
      expect(token(rule, "--accent")).toBe(expectedAccentFill);

      for (const surfaceValue of surfaces) {
        const surface = hexToRgb(surfaceValue);
        expect(
          contrastRatio(rgbaOver(mutedText, surface), surface),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(hexToRgb(accentText), surface),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("limits the section bridge to text color utilities", () => {
    const bridgeRules = [
      ...NUPHY_SCOPE_CSS.matchAll(
        /([^{}]*data-cloud-section-theme="eliza"[^{}]*)\{([^{}]*)\}/g,
      ),
    ];

    expect(bridgeRules).toHaveLength(5);
    expect(NUPHY_SCOPE_CSS).toContain(
      ":is(.text-muted, .text-muted-foreground)",
    );
    expect(NUPHY_SCOPE_CSS).toContain(".text-accent");
    expect(NUPHY_SCOPE_CSS).toContain(".placeholder\\:text-muted::placeholder");
    expect(NUPHY_SCOPE_CSS).toContain(".hover\\:text-accent:hover");
    expect(NUPHY_SCOPE_CSS).toContain(".disabled\\:text-muted:disabled");

    for (const [, , declarations] of bridgeRules) {
      expect(declarations).toMatch(
        /^\s*color:\s*var\(--cloud-section-[^)]+\);\s*$/,
      );
      expect(declarations).not.toMatch(
        /(?:background|border|ring)(?:-color)?\s*:|--(?:muted|accent)\s*:/,
      );
    }
  });
});
