/**
 * Unit tests for the Aesthetic Audit Rules app audit helper used by visual
 * review evidence.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bucket,
  buildMinimalismBaseline,
  computeVerdict,
  evaluateAestheticMetricBudget,
  evaluateMinimalismRatchet,
  evaluateStrictGate,
  exceedsMinimalismBudget,
  type GateFinding,
  MINIMALISM_DENSITY_CEILING,
  MINIMALISM_RATCHET_TOLERANCE,
  minimalismBaselineKey,
  minimalismDensity,
  OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  parseMinimalismBaseline,
  parseNavigationTabPaths,
  parseRgb,
  resolveAuditStrictFlags,
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
  it("treats a near-black dark scrim as black, not blue — audit false-positive (#10710)", () => {
    // rgba(10,10,12): chroma is only 2 (b just 2 above r,g), but at this low
    // luminance chroma/max = 0.17 slips past the saturation-ratio gate and the
    // hue lands at 240° → a naive classifier mislabels an essentially-BLACK
    // scrim as "blue". Because the chat overlay paints this scrim on EVERY view,
    // that single false-positive dragged all 236 default view/viewport combos to
    // `needs-work`. The absolute-chroma floor keeps it out of the blue band.
    expect(bucket("rgba(10, 10, 12, 0.5)")).toBe("black");
    expect(bucket("rgb(12, 12, 14)")).toBe("black");
    // A faint cool-gray light surface likewise stays neutral, not blue.
    expect(bucket("rgb(240, 241, 244)")).toBe("neutral");
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

describe("minimalism ratchet (#9950 Her-minimal gate teeth)", () => {
  // A breaching gui view: density 100/Mpx² over the 45 ceiling, with the
  // count/area pair kept numerically consistent with borderDividerDensity.
  const breaching = (o: Partial<VerdictFinding> = {}): VerdictFinding => ({
    slug: "plugin-foo-gui",
    viewType: "gui",
    consoleErrors: [],
    qualityIssues: [],
    readableChars: 500,
    borderDividerDensity: 100,
    textDensity: 10,
    whitespaceRatio: 0.4,
    blueColors: [],
    hoverViolations: [],
    overlayPresent: true,
    overlayClearanceIssues: [],
    borderRadiusViolations: [],
    borderDividerCount: 100,
    viewportArea: 1_000_000,
    ...o,
  });
  const baselineEntry = {
    borderDividerDensity: 100,
    textDensity: 10,
    whitespaceRatio: 0.4,
  };

  it("a breaching view NOT in the baseline is a new breach → blocks as needs-work", () => {
    const violations = evaluateMinimalismRatchet(breaching(), undefined);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/new minimalism breach/);
    expect(violations[0]).toMatch(/no committed baseline entry/);
    expect(
      computeVerdict({
        ...breaching(),
        minimalismRatchetViolations: violations,
      }),
    ).toBe("needs-work");
  });

  it("a baselined breach within tolerance stays SOFT (needs-eyeball, not blocking)", () => {
    const violations = evaluateMinimalismRatchet(breaching(), baselineEntry);
    expect(violations).toEqual([]);
    expect(
      computeVerdict({
        ...breaching(),
        minimalismRatchetViolations: violations,
      }),
    ).toBe("needs-eyeball");
  });

  it("a baselined view that regressed past tolerance blocks — on any of the three metrics", () => {
    // Divider density: 100 → 106 is > 100 × 1.05.
    const denser = breaching({ borderDividerDensity: 106 });
    const denserViolations = evaluateMinimalismRatchet(denser, baselineEntry);
    expect(denserViolations).toHaveLength(1);
    expect(denserViolations[0]).toMatch(/border\/divider density regressed/);
    expect(
      computeVerdict({
        ...denser,
        minimalismRatchetViolations: denserViolations,
      }),
    ).toBe("needs-work");
    // Text density: 10 → 10.6 is > 10 × 1.05.
    expect(
      evaluateMinimalismRatchet(
        breaching({ textDensity: 10.6 }),
        baselineEntry,
      ),
    ).toEqual([expect.stringMatching(/text density regressed/)]);
    // Whitespace (lower is worse): 0.4 → 0.37 is < 0.4 × 0.95.
    expect(
      evaluateMinimalismRatchet(
        breaching({ whitespaceRatio: 0.37 }),
        baselineEntry,
      ),
    ).toEqual([expect.stringMatching(/whitespace ratio regressed/)]);
  });

  it("drift exactly at the ±5% tolerance boundary does not block", () => {
    expect(
      evaluateMinimalismRatchet(
        breaching({
          borderDividerDensity: 105,
          textDensity: 10.5,
          whitespaceRatio: 0.38,
        }),
        baselineEntry,
      ),
    ).toEqual([]);
    expect(MINIMALISM_RATCHET_TOLERANCE).toBe(0.05);
  });

  it("an improvement never blocks (and tightening is only via a deliberate refresh)", () => {
    expect(
      evaluateMinimalismRatchet(
        breaching({
          borderDividerDensity: 60,
          textDensity: 5,
          whitespaceRatio: 0.6,
        }),
        baselineEntry,
      ),
    ).toEqual([]);
  });

  it("views at or under the ceiling never engage the ratchet — they behave as before", () => {
    const clean = breaching({
      borderDividerDensity: MINIMALISM_DENSITY_CEILING,
      borderDividerCount: MINIMALISM_DENSITY_CEILING,
      // Even with a baseline entry that current metrics "regress" against.
      textDensity: 99,
      whitespaceRatio: 0.01,
    });
    expect(evaluateMinimalismRatchet(clean, undefined)).toEqual([]);
    expect(evaluateMinimalismRatchet(clean, baselineEntry)).toEqual([]);
    expect(computeVerdict({ ...clean, minimalismRatchetViolations: [] })).toBe(
      "good",
    );
  });

  it("TUI and overlay-native surfaces are exempt from the ratchet", () => {
    expect(
      evaluateMinimalismRatchet(breaching({ viewType: "tui" }), undefined),
    ).toEqual([]);
    expect(
      evaluateMinimalismRatchet(breaching({ slug: "builtin-chat" }), undefined),
    ).toEqual([]);
  });

  it("honors caller-supplied ceiling and tolerance overrides", () => {
    const f = breaching({ borderDividerDensity: 30, borderDividerCount: 30 });
    // Density 30 breaches a ceiling of 20 → new breach.
    expect(
      evaluateMinimalismRatchet(f, undefined, { ceiling: 20 }),
    ).toHaveLength(1);
    // A 10% tolerance forgives the 6% regression that blocks at 5%.
    expect(
      evaluateMinimalismRatchet(
        breaching({ borderDividerDensity: 106 }),
        baselineEntry,
        { tolerance: 0.1 },
      ),
    ).toEqual([]);
  });
});

describe("minimalism baseline parse/build (#9950 update path)", () => {
  it("minimalismBaselineKey is `<slug>@<viewport>`", () => {
    expect(minimalismBaselineKey("builtin-settings", "desktop-landscape")).toBe(
      "builtin-settings@desktop-landscape",
    );
  });

  it("parses a valid baseline and round-trips the entries", () => {
    const parsed = parseMinimalismBaseline(
      JSON.stringify({
        generatedAt: "2026-07-01T00:00:00.000Z",
        views: {
          "builtin-settings@desktop-landscape": {
            borderDividerDensity: 512.3,
            textDensity: 61.2,
            whitespaceRatio: 0.18,
          },
        },
      }),
    );
    expect(parsed.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(parsed.views["builtin-settings@desktop-landscape"]).toEqual({
      borderDividerDensity: 512.3,
      textDensity: 61.2,
      whitespaceRatio: 0.18,
    });
  });

  it("throws loudly on malformed baselines — a corrupt file must never soften the gate", () => {
    expect(() => parseMinimalismBaseline("[]")).toThrow(/JSON object/);
    expect(() => parseMinimalismBaseline("{}")).toThrow(/generatedAt/);
    expect(() =>
      parseMinimalismBaseline(JSON.stringify({ generatedAt: "x" })),
    ).toThrow(/views/);
    expect(() =>
      parseMinimalismBaseline(
        JSON.stringify({ generatedAt: "x", views: { "a@b": 3 } }),
      ),
    ).toThrow(/must be an object/);
    expect(() =>
      parseMinimalismBaseline(
        JSON.stringify({
          generatedAt: "x",
          views: {
            "a@b": {
              borderDividerDensity: "512",
              textDensity: 1,
              whitespaceRatio: 0.5,
            },
          },
        }),
      ),
    ).toThrow(/non-numeric `borderDividerDensity`/);
  });

  it("the COMMITTED baseline file parses (spec-load integrity)", () => {
    // process.cwd() is the vitest root (packages/app); jsdom rewrites
    // import.meta.url to a non-file scheme, so resolve from the root.
    const committed = readFileSync(
      path.join(
        process.cwd(),
        "test/ui-smoke/aesthetic-minimalism-baseline.json",
      ),
      "utf8",
    );
    const parsed = parseMinimalismBaseline(committed);
    expect(typeof parsed.generatedAt).toBe("string");
    // Every committed entry must itself be a breach — a non-breaching entry is
    // stale and should have been pruned by the update script.
    for (const [key, entry] of Object.entries(parsed.views)) {
      expect(
        entry.borderDividerDensity,
        `${key} baselined below the ceiling — stale entry`,
      ).toBeGreaterThan(MINIMALISM_DENSITY_CEILING);
    }
  });

  it("update mode records exactly the breaching non-exempt views, sorted, and prunes the rest", () => {
    const baseline = buildMinimalismBaseline(
      [
        // Breaching gui views — recorded (given out of order to test sorting).
        {
          slug: "builtin-settings",
          viewport: "mobile-portrait",
          viewType: "gui",
          borderDividerDensity: 300,
          textDensity: 61.2,
          whitespaceRatio: 0.18,
        },
        {
          slug: "builtin-automations",
          viewport: "desktop-landscape",
          viewType: "gui",
          borderDividerDensity: 46,
          textDensity: 20,
          whitespaceRatio: 0.3,
        },
        // At the ceiling → NOT a breach → pruned.
        {
          slug: "builtin-files",
          viewport: "desktop-landscape",
          viewType: "gui",
          borderDividerDensity: MINIMALISM_DENSITY_CEILING,
          textDensity: 10,
          whitespaceRatio: 0.5,
        },
        // Exempt surfaces → never recorded even when dense.
        {
          slug: "plugin-terminal-tui",
          viewport: "desktop-landscape",
          viewType: "tui",
          borderDividerDensity: 900,
          textDensity: 90,
          whitespaceRatio: 0.05,
        },
        {
          slug: "builtin-chat",
          viewport: "mobile-portrait",
          viewType: "gui",
          borderDividerDensity: 900,
          textDensity: 90,
          whitespaceRatio: 0.05,
        },
      ],
      "2026-07-01T12:00:00.000Z",
    );
    expect(baseline.generatedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(Object.keys(baseline.views)).toEqual([
      "builtin-automations@desktop-landscape",
      "builtin-settings@mobile-portrait",
    ]);
    expect(baseline.views["builtin-settings@mobile-portrait"]).toEqual({
      borderDividerDensity: 300,
      textDensity: 61.2,
      whitespaceRatio: 0.18,
    });
    // The build output feeds straight back into the gate: the recorded view is
    // now within tolerance (soft), an unrecorded breach still blocks.
    const recorded = baseline.views["builtin-settings@mobile-portrait"];
    expect(
      evaluateMinimalismRatchet(
        {
          slug: "builtin-settings",
          viewType: "gui",
          consoleErrors: [],
          qualityIssues: [],
          readableChars: 500,
          borderDividerDensity: 300,
          textDensity: 61.2,
          whitespaceRatio: 0.18,
          blueColors: [],
          hoverViolations: [],
          overlayPresent: true,
          overlayClearanceIssues: [],
          borderRadiusViolations: [],
        },
        recorded,
      ),
    ).toEqual([]);
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

describe("evaluateStrictGate (#9304 / #10710 strict verdict gate)", () => {
  const gateFinding = (o: Partial<GateFinding> = {}): GateFinding => ({
    slug: "plugin-foo-gui",
    viewport: "desktop",
    verdict: "good",
    consoleErrors: [],
    qualityIssues: [],
    readableChars: 500,
    ...o,
  });

  it("default opts: only undebted `broken` fails; `needs-work` is logged, not gated", () => {
    const findings = [
      gateFinding({ slug: "a", verdict: "broken", consoleErrors: ["boom"] }),
      gateFinding({ slug: "b", verdict: "needs-work" }),
      gateFinding({ slug: "c", verdict: "good" }),
    ];
    const gate = evaluateStrictGate(findings, {});
    // strict defaults on → the undebted broken view is a hard fail.
    expect(gate.undebtedBroken.map((f) => f.slug)).toEqual(["a"]);
    expect(gate.failed).toBe(true);
    expect(gate.message).toContain("STRICT gate failed");
    expect(gate.message).toContain("a @ desktop: boom");
    // needs-work is surfaced in the tally but does not fail the run by default.
    expect(gate.undebtedNeedsWork.map((f) => f.slug)).toEqual(["b"]);
    expect(gate.message).not.toContain("'needs-work'");
  });

  it("default opts + only an undebted `needs-work`: passes (no broken to gate)", () => {
    const findings = [gateFinding({ slug: "b", verdict: "needs-work" })];
    const gate = evaluateStrictGate(findings, {});
    expect(gate.undebtedNeedsWork.map((f) => f.slug)).toEqual(["b"]);
    expect(gate.failed).toBe(false);
    expect(gate.message).toBe("");
  });

  it("a `broken` debt entry tolerates that view's broken render (no fail)", () => {
    const findings = [
      gateFinding({ slug: "a", verdict: "broken", consoleErrors: ["boom"] }),
    ];
    const gate = evaluateStrictGate(findings, { "a-desktop": "broken" });
    expect(gate.undebtedBroken).toEqual([]);
    expect(gate.failed).toBe(false);
  });

  it("a `needs-work` debt entry does NOT tolerate a broken render", () => {
    const findings = [
      gateFinding({ slug: "a", verdict: "broken", consoleErrors: ["boom"] }),
    ];
    const gate = evaluateStrictGate(findings, { "a-desktop": "needs-work" });
    expect(gate.undebtedBroken.map((f) => f.slug)).toEqual(["a"]);
    expect(gate.failed).toBe(true);
  });

  it("needsWorkStrict on: an undebted `needs-work` also fails; a debted one does not", () => {
    const findings = [
      gateFinding({ slug: "fresh", verdict: "needs-work" }),
      gateFinding({ slug: "allowlisted", verdict: "needs-work" }),
    ];
    const gate = evaluateStrictGate(
      findings,
      { "allowlisted-desktop": "needs-work" },
      { needsWorkStrict: true },
    );
    expect(gate.undebtedNeedsWork.map((f) => f.slug)).toEqual(["fresh"]);
    expect(gate.failed).toBe(true);
    expect(gate.message).toContain("'needs-work'");
    expect(gate.message).toContain("fresh @ desktop");
    expect(gate.message).not.toContain("allowlisted @ desktop");
  });

  it("needsWorkStrict on: a `broken` debt entry ALSO tolerates a needs-work for that slug", () => {
    const findings = [
      gateFinding({
        slug: "tolerated",
        viewport: "mobile",
        verdict: "needs-work",
      }),
    ];
    const gate = evaluateStrictGate(
      findings,
      { "tolerated-mobile": "broken" },
      { needsWorkStrict: true },
    );
    expect(gate.undebtedNeedsWork).toEqual([]);
    expect(gate.failed).toBe(false);
    expect(gate.message).toBe("");
  });

  it("strict off: the tally is still computed but nothing fails (default-behavior parity)", () => {
    const findings = [
      gateFinding({ slug: "a", verdict: "broken", consoleErrors: ["boom"] }),
      gateFinding({ slug: "b", verdict: "needs-work" }),
    ];
    const gate = evaluateStrictGate(findings, {}, { strict: false });
    // Findings are still classified for the log line…
    expect(gate.undebtedBroken.map((f) => f.slug)).toEqual(["a"]);
    expect(gate.undebtedNeedsWork.map((f) => f.slug)).toEqual(["b"]);
    // …but with strict off and needsWorkStrict off, the run does not fail.
    expect(gate.failed).toBe(false);
    expect(gate.message).toBe("");
  });

  it("reports both broken and needs-work sections when both flags gate", () => {
    const findings = [
      gateFinding({ slug: "crash", verdict: "broken", readableChars: 0 }),
      gateFinding({ slug: "debt", verdict: "needs-work" }),
    ];
    const gate = evaluateStrictGate(findings, {}, { needsWorkStrict: true });
    expect(gate.failed).toBe(true);
    expect(gate.message).toContain("'broken'");
    expect(gate.message).toContain("crash @ desktop: readableChars=0");
    expect(gate.message).toContain("'needs-work'");
    expect(gate.message).toContain("debt @ desktop");
  });
});

describe("resolveAuditStrictFlags (#10710 default-on gate)", () => {
  it("defaults BOTH gates on when the vars are unset", () => {
    expect(resolveAuditStrictFlags({})).toEqual({
      strict: true,
      needsWorkStrict: true,
    });
  });

  it('opts out only on an explicit "0"', () => {
    expect(
      resolveAuditStrictFlags({
        ELIZA_AUDIT_APP_STRICT: "0",
        ELIZA_AUDIT_APP_STRICT_NEEDS_WORK: "0",
      }),
    ).toEqual({ strict: false, needsWorkStrict: false });
  });

  it('stays on for "1" — parity with the app-aesthetic-audit CI lane', () => {
    expect(
      resolveAuditStrictFlags({
        ELIZA_AUDIT_APP_STRICT: "1",
        ELIZA_AUDIT_APP_STRICT_NEEDS_WORK: "1",
      }),
    ).toEqual({ strict: true, needsWorkStrict: true });
  });

  it("gates each axis independently", () => {
    expect(
      resolveAuditStrictFlags({ ELIZA_AUDIT_APP_STRICT_NEEDS_WORK: "0" }),
    ).toEqual({ strict: true, needsWorkStrict: false });
    expect(resolveAuditStrictFlags({ ELIZA_AUDIT_APP_STRICT: "0" })).toEqual({
      strict: false,
      needsWorkStrict: true,
    });
  });

  it('treats any non-"0" value as on', () => {
    expect(
      resolveAuditStrictFlags({
        ELIZA_AUDIT_APP_STRICT: "",
        ELIZA_AUDIT_APP_STRICT_NEEDS_WORK: "true",
      }),
    ).toEqual({ strict: true, needsWorkStrict: true });
  });
});
