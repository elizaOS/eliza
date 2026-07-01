import { describe, expect, it } from "vitest";
import {
  bucket,
  computeVerdict,
  evaluateAestheticMetricBudget,
  exceedsMinimalismBudget,
  MINIMALISM_DENSITY_CEILING,
  minimalismDensity,
  OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  parseNavigationTabPaths,
  parseRgb,
  type VerdictFinding,
} from "../ui-smoke/aesthetic-audit-rules";

describe("parseRgb (#8796)", () => {
  it("parses rgb() and rgba(), defaulting alpha to 1", () => {
    expect(parseRgb("rgb(255, 0, 0)")).toEqual([255, 0, 0, 1]);
    expect(parseRgb("rgba(0, 0, 0, 0.5)")).toEqual([0, 0, 0, 0.5]);
  });
  it("returns null for non-rgb strings", () => {
    expect(parseRgb("transparent")).toBeNull();
    expect(parseRgb("rgb(1, 2)")).toBeNull();
    expect(parseRgb("#fff")).toBeNull();
  });
});

describe("bucket (#8796 no-blue / orange detection)", () => {
  it("buckets the brand orange as orange", () => {
    expect(bucket("rgb(230, 126, 34)")).toBe("orange");
  });
  // Regression (#9304): the SHIPPED brand accent is `--accent-rgb: 255,88,0`
  // (base.css / theme.css). The old `g>90` channel threshold misclassified it
  // as `neutral`, so the no-blue / orange-hover detector silently skipped the
  // real brand button. Hue-based bucketing fixes this.
  it("buckets the SHIPPED brand accent 255,88,0 (#ff5800) as orange", () => {
    expect(bucket("rgb(255, 88, 0)")).toBe("orange");
    expect(bucket("rgba(255, 88, 0, 1)")).toBe("orange");
  });
  it("buckets the brand-orange #ff8a24 and the gold theme accent as orange", () => {
    expect(bucket("rgb(255, 138, 36)")).toBe("orange"); // --brand-orange #ff8a24
    expect(bucket("rgb(240, 185, 11)")).toBe("orange"); // brand-gold #f0b90b
  });
  it("buckets blues across the band (incl. azure / dodgerblue) as blue", () => {
    expect(bucket("rgb(40, 90, 230)")).toBe("blue");
    expect(bucket("rgb(30, 144, 255)")).toBe("blue"); // dodgerblue ~210°
    expect(bucket("rgb(99, 102, 241)")).toBe("blue"); // indigo-500 ~239°
  });
  it("catches a saturated DARK navy as blue (not black) — the brand violation must surface", () => {
    // hue ~240°, lum < 0.08 — old code returned `black` via the early luminance
    // return, letting a dark-blue brand violation escape the no-blue rule.
    expect(bucket("rgb(10, 10, 40)")).toBe("blue");
  });
  it("buckets near-black and pure white", () => {
    expect(bucket("rgb(10, 10, 10)")).toBe("black");
    expect(bucket("rgb(255, 255, 255)")).toBe("white");
  });
  it("buckets fully transparent and low-saturation gray", () => {
    expect(bucket("rgba(0, 0, 255, 0)")).toBe("transparent");
    expect(bucket("rgb(128, 128, 128)")).toBe("neutral");
    expect(bucket("rgb(200, 200, 205)")).toBe("neutral"); // light gray, not white
  });
  it("non-brand chromatic colors (red/yellow/green/cyan) are neutral, never blue/orange", () => {
    expect(bucket("rgb(255, 0, 0)")).toBe("neutral"); // hue 0° — outside orange band
    expect(bucket("rgb(255, 255, 0)")).toBe("neutral"); // yellow 60°
    expect(bucket("rgb(0, 200, 0)")).toBe("neutral"); // green 120°
    expect(bucket("rgb(0, 200, 200)")).toBe("neutral"); // cyan/teal 180° — NOT blue
  });
  it("orange/blue hue band boundaries", () => {
    // ~9° (just below orange band) is neutral; ~12° is orange.
    expect(bucket("rgb(255, 40, 0)")).not.toBe("orange");
    expect(bucket("rgb(255, 70, 0)")).toBe("orange");
  });
  it("unparseable colors fall back to neutral (never blue)", () => {
    expect(bucket("not-a-color")).toBe("neutral");
  });
});

describe("parseNavigationTabPaths (#8796)", () => {
  it("extracts the TAB_PATHS map (quoted and unquoted keys)", () => {
    const src = `
      type BuiltinTab = "home" | "chat";
      export const TAB_PATHS: Record<BuiltinTab, string> = {
        home: "/",
        "chat": "/chat",
      };
    `;
    expect(parseNavigationTabPaths(src)).toEqual({ home: "/", chat: "/chat" });
  });
  it("throws when TAB_PATHS is absent", () => {
    expect(() => parseNavigationTabPaths("export const X = 1;")).toThrow(
      /could not locate TAB_PATHS/,
    );
  });
});

describe("computeVerdict (#8796 verdict precedence)", () => {
  const finding = (o: Partial<VerdictFinding> = {}): VerdictFinding => ({
    slug: "plugin-foo-gui",
    viewType: "gui",
    consoleErrors: [],
    qualityIssues: [],
    readableChars: 500,
    borderDividerDensity: 20,
    textDensity: 8,
    whitespaceRatio: 0.72,
    blueColors: [],
    hoverViolations: [],
    overlayPresent: true,
    overlayClearanceIssues: [],
    borderRadiusViolations: [],
    ...o,
  });

  it("a clean gui view is good", () => {
    expect(computeVerdict(finding())).toBe("good");
  });

  it("any console error is broken — even on an exempt surface", () => {
    expect(computeVerdict(finding({ consoleErrors: ["boom"] }))).toBe("broken");
    expect(
      computeVerdict(finding({ viewType: "tui", consoleErrors: ["boom"] })),
    ).toBe("broken");
  });

  it("a gui view with quality issues or no readable content is broken", () => {
    expect(computeVerdict(finding({ qualityIssues: ["blurry"] }))).toBe(
      "broken",
    );
    expect(computeVerdict(finding({ readableChars: 0 }))).toBe("broken");
  });

  it("TUI and overlay surfaces are exempt from the quality/content floors", () => {
    expect(
      computeVerdict(
        finding({ viewType: "tui", qualityIssues: ["x"], readableChars: 0 }),
      ),
    ).toBe("good");
    expect(
      computeVerdict(
        finding({
          slug: "builtin-chat",
          qualityIssues: ["x"],
          readableChars: 0,
        }),
      ),
    ).toBe("good");
  });

  it("the no-blue rule still applies to overlay surfaces", () => {
    expect(OVERLAY_NATIVE_OR_CANVAS_SLUGS.has("builtin-chat")).toBe(true);
    expect(
      computeVerdict(
        finding({ slug: "builtin-chat", blueColors: ["rgb(0,0,255)"] }),
      ),
    ).toBe("needs-work");
  });

  it("blue / hover violations / missing overlay are needs-work on a gui view", () => {
    expect(computeVerdict(finding({ blueColors: ["rgb(0,0,255)"] }))).toBe(
      "needs-work",
    );
    expect(computeVerdict(finding({ hoverViolations: ["x"] }))).toBe(
      "needs-work",
    );
    expect(computeVerdict(finding({ overlayPresent: false }))).toBe(
      "needs-work",
    );
    expect(
      computeVerdict(finding({ overlayClearanceIssues: ["clipped"] })),
    ).toBe("needs-work");
  });

  it("off-scale border radius is a soft needs-eyeball (non-blocking)", () => {
    expect(computeVerdict(finding({ borderRadiusViolations: ["32px"] }))).toBe(
      "needs-eyeball",
    );
  });

  it("divider density over the minimal ceiling is a soft needs-eyeball (#9950)", () => {
    // 100 dividers over a 1,000,000 px² viewport = 100/Mpx² » the 45 ceiling.
    expect(
      computeVerdict(
        finding({ borderDividerCount: 100, viewportArea: 1_000_000 }),
      ),
    ).toBe("needs-eyeball");
  });

  it("a sparse view stays good; a real crash still outranks the soft minimalism signal (#9950)", () => {
    // Under the ceiling → still good.
    expect(
      computeVerdict(
        finding({ borderDividerCount: 10, viewportArea: 1_000_000 }),
      ),
    ).toBe("good");
    // A console error outranks any minimalism breach.
    expect(
      computeVerdict(
        finding({
          consoleErrors: ["boom"],
          borderDividerCount: 100,
          viewportArea: 1_000_000,
        }),
      ),
    ).toBe("broken");
  });
});

describe("minimalism density gate (#9950)", () => {
  const finding = (o: Partial<VerdictFinding> = {}): VerdictFinding => ({
    slug: "plugin-foo-gui",
    viewType: "gui",
    consoleErrors: [],
    qualityIssues: [],
    readableChars: 500,
    borderDividerDensity: 20,
    textDensity: 8,
    whitespaceRatio: 0.72,
    blueColors: [],
    hoverViolations: [],
    overlayPresent: true,
    overlayClearanceIssues: [],
    borderRadiusViolations: [],
    ...o,
  });

  it("returns null when the finding carries no minimalism measurement", () => {
    expect(minimalismDensity(finding())).toBeNull();
    expect(exceedsMinimalismBudget(finding())).toBe(false);
    // A zero/absent viewport area is treated as unmeasured, not a divide-by-zero.
    expect(
      minimalismDensity(finding({ borderDividerCount: 5, viewportArea: 0 })),
    ).toBeNull();
  });

  it("normalizes border/divider count by viewport area (per 1,000,000 px²)", () => {
    expect(
      minimalismDensity(
        finding({ borderDividerCount: 45, viewportArea: 1_000_000 }),
      ),
    ).toBe(45);
    // Same divider count on a smaller viewport is a HIGHER density (more cramped).
    expect(
      minimalismDensity(
        finding({ borderDividerCount: 45, viewportArea: 500_000 }),
      ),
    ).toBe(90);
  });

  it("trips only when density strictly exceeds the ceiling", () => {
    // Exactly at the ceiling is not a breach.
    expect(
      exceedsMinimalismBudget(
        finding({
          borderDividerCount: MINIMALISM_DENSITY_CEILING,
          viewportArea: 1_000_000,
        }),
      ),
    ).toBe(false);
    expect(
      exceedsMinimalismBudget(
        finding({
          borderDividerCount: MINIMALISM_DENSITY_CEILING + 1,
          viewportArea: 1_000_000,
        }),
      ),
    ).toBe(true);
  });

  it("honors a caller-supplied ceiling (per-view ratcheting)", () => {
    const f = finding({ borderDividerCount: 20, viewportArea: 1_000_000 });
    expect(exceedsMinimalismBudget(f, 10)).toBe(true);
    expect(exceedsMinimalismBudget(f, 30)).toBe(false);
  });
});

describe("evaluateAestheticMetricBudget (#9950 minimalism gate)", () => {
  it("reports each over-budget minimalism metric", () => {
    expect(
      evaluateAestheticMetricBudget(
        {
          borderDividerDensity: 42,
          textDensity: 18,
          whitespaceRatio: 0.24,
        },
        {
          maxBorderDividerDensity: 40,
          maxTextDensity: 12,
          minWhitespaceRatio: 0.3,
        },
      ),
    ).toEqual([
      "border/divider density 42.00 > 40.00",
      "text density 18.00 > 12.00",
      "whitespace ratio 0.24 < 0.30",
    ]);
  });

  it("passes when all minimalism metrics are within budget", () => {
    expect(
      evaluateAestheticMetricBudget(
        {
          borderDividerDensity: 39.9,
          textDensity: 12,
          whitespaceRatio: 0.3,
        },
        {
          maxBorderDividerDensity: 40,
          maxTextDensity: 12,
          minWhitespaceRatio: 0.3,
        },
      ),
    ).toEqual([]);
  });
});
