/**
 * Pure brand-color / verdict policy for the all-views aesthetic audit (#8796).
 *
 * These are the heart of the audit's acceptance criteria — no-blue detection,
 * orange/black/blue color bucketing, the TUI/overlay-canvas exemptions, and the
 * verdict precedence — extracted out of the Playwright spec (which imports
 * `@playwright/test` + a live `page`, so the rules were unreachable by vitest)
 * into this dependency-free module so they can be unit-tested. The spec imports
 * them from here; the test lives in `test/audit/` (vitest excludes
 * `test/ui-smoke/**`).
 */

export type Bucket =
  | "orange"
  | "black"
  | "blue"
  | "white"
  | "neutral"
  | "transparent";

export type AestheticVerdict =
  | "good"
  | "needs-work"
  | "needs-eyeball"
  | "broken";

/** The subset of a view audit finding the verdict policy reads. The spec's
 * fuller `ViewFinding` is structurally assignable to this. */
export interface VerdictFinding {
  slug: string;
  viewType: "gui" | "tui";
  consoleErrors: string[];
  qualityIssues: string[];
  /** Readable text length in the view root; ~0 means the view never painted. */
  readableChars: number;
  /** Border/divider edges per 1M viewport pixels. */
  borderDividerDensity: number;
  /** Visible text characters per 10K viewport pixels. */
  textDensity: number;
  /** Estimated unoccupied viewport ratio, 0..1. */
  whitespaceRatio: number;
  blueColors: string[];
  hoverViolations: string[];
  overlayPresent: boolean;
  overlayClearanceIssues: string[];
  borderRadiusViolations: string[];
  /**
   * Count of rendered border/divider elements (a visible border on any side,
   * plus `<hr>` / `role="separator"`). The "Her"-minimal axis (#9950): a cramped,
   * divider-heavy view should not pass `good`. Optional so existing callers and
   * unit fixtures need not set it; when present it is normalized by viewport area
   * and checked against {@link MINIMALISM_DENSITY_CEILING}.
   */
  borderDividerCount?: number;
  /** Rendered viewport area in px² (innerWidth × innerHeight), the density basis. */
  viewportArea?: number;
}

/**
 * Soft "Her"-minimal ceiling: border/divider elements per 1,000,000 px² of
 * viewport. A density (area-normalized), not a raw per-view count, so one ceiling
 * holds across the portrait / landscape / desktop matrix. Seeded generously so it
 * only trips genuinely divider-dense screens today; ratchet down as the aesthetic
 * pass lands (#9950). A breach is a SOFT `needs-eyeball`, never a hard fail — it
 * records the regression without destabilizing the green baseline (same posture
 * as the off-token border-radius signal).
 */
export const MINIMALISM_DENSITY_CEILING = 45;

/**
 * Border/divider density per 1,000,000 px², or null when the finding carries no
 * minimalism measurement (the fields are optional). Pure.
 */
export function minimalismDensity(finding: VerdictFinding): number | null {
  if (
    finding.borderDividerCount === undefined ||
    finding.viewportArea === undefined ||
    finding.viewportArea <= 0
  ) {
    return null;
  }
  return (finding.borderDividerCount / finding.viewportArea) * 1_000_000;
}

/** True when a view's divider density exceeds the minimal-aesthetic ceiling. */
export function exceedsMinimalismBudget(
  finding: VerdictFinding,
  ceiling: number = MINIMALISM_DENSITY_CEILING,
): boolean {
  const density = minimalismDensity(finding);
  return density !== null && density > ceiling;
}

export interface AestheticMetricBudget {
  /** Max border/divider edges per 1M viewport pixels. */
  maxBorderDividerDensity: number;
  /** Max visible text characters per 10K viewport pixels. */
  maxTextDensity: number;
  /** Min estimated unoccupied viewport ratio, 0..1. */
  minWhitespaceRatio: number;
}

function formatMetric(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

export function evaluateAestheticMetricBudget(
  finding: Pick<
    VerdictFinding,
    "borderDividerDensity" | "textDensity" | "whitespaceRatio"
  >,
  budget: AestheticMetricBudget,
): string[] {
  const issues: string[] = [];
  if (finding.borderDividerDensity > budget.maxBorderDividerDensity) {
    issues.push(
      `border/divider density ${formatMetric(finding.borderDividerDensity)} > ${formatMetric(
        budget.maxBorderDividerDensity,
      )}`,
    );
  }
  if (finding.textDensity > budget.maxTextDensity) {
    issues.push(
      `text density ${formatMetric(finding.textDensity)} > ${formatMetric(
        budget.maxTextDensity,
      )}`,
    );
  }
  if (finding.whitespaceRatio < budget.minWhitespaceRatio) {
    issues.push(
      `whitespace ratio ${formatMetric(finding.whitespaceRatio)} < ${formatMetric(
        budget.minWhitespaceRatio,
      )}`,
    );
  }
  return issues;
}

/** Parse the `TAB_PATHS` map out of the navigation index source. */
export function parseNavigationTabPaths(
  source: string,
): Record<string, string> {
  const block = source.match(
    /export const TAB_PATHS\s*:\s*Record<BuiltinTab,\s*string>\s*=\s*\{([\s\S]*?)\};/,
  );
  if (!block) {
    throw new Error(
      "[aesthetic-audit-rules] could not locate TAB_PATHS in the navigation index source",
    );
  }
  const entries: Record<string, string> = {};
  const entryRe = /"?([a-z][a-z-]*)"?\s*:\s*"([^"]+)"/g;
  for (const m of block[1].matchAll(entryRe)) {
    entries[m[1]] = m[2];
  }
  return entries;
}

/** Parse a CSS `rgb()` / `rgba()` string to `[r, g, b, a]`, or null. */
export function parseRgb(
  input: string,
): [number, number, number, number] | null {
  const m = input.match(
    /^rgba?\(\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)(?:\s*,\s*(\d+\.?\d*))?\s*\)$/,
  );
  if (!m) return null;
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] === undefined ? 1 : Number(m[4]),
  ];
}

/**
 * Bucket a CSS color into a coarse brand category.
 *
 * Chromatic classification is HUE-based, not raw-channel-threshold based. The
 * old `r>200 && g>90 && g<200 && b<100` orange test silently failed the SHIPPED
 * brand accent `--accent-rgb: 255,88,0` (g=88 < 90 → fell through to neutral),
 * so the no-blue / orange-hover detectors skipped the real brand button. Hue is
 * the correct axis: orange/amber lives at ~10–50°, blue/indigo at ~200–270°,
 * regardless of channel magnitudes.
 *
 * The blue test also runs BEFORE the low-luminance black fall-through, so a
 * saturated dark navy (`rgb(10,10,40)`) is reported as a brand violation instead
 * of escaping as "black".
 */
export function bucket(color: string): Bucket {
  const rgb = parseRgb(color);
  if (!rgb) return "neutral";
  const [r, g, b, a] = rgb;
  if (a === 0) return "transparent";
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const saturation = max === 0 ? 0 : chroma / max;

  // Very light + near-achromatic = white.
  if (lum > 0.95 && saturation < 0.05) return "white";
  // Achromatic (gray scale): neutral, or black only when genuinely dark.
  // Gate on ABSOLUTE chroma too, not just the saturation RATIO: at low
  // luminance a 1–2/255 channel spread yields a high `chroma/max` ratio yet is
  // perceptually black — so a dark scrim like `rgba(10,10,12,0.5)` (chroma 2,
  // ratio 0.17) must not escape this gate and get hue-classified as a saturated
  // "blue" (240°), which mislabels an essentially-black overlay as a brand
  // violation. A genuinely-saturated dark navy `rgb(10,10,40)` has chroma 30 and
  // still falls through to the blue band below.
  if (saturation < 0.15 || chroma < 12) return lum < 0.08 ? "black" : "neutral";

  // Chromatic — classify by hue (degrees, 0–360).
  let hue = 0;
  if (chroma > 0) {
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  // Blue band first, so a dark-but-saturated navy is caught (not bucketed black).
  if (hue >= 200 && hue <= 270) return "blue";
  // Orange / amber band — covers #ff5800 (~21°) through brand gold #f0b90b (~46°).
  if (hue >= 10 && hue <= 50) return "orange";
  // Any other chromatic color that is very dark reads as black.
  if (lum < 0.08) return "black";
  return "neutral";
}

/** Overlay-native / canvas / game surfaces that own their own chrome and so are
 * exempt from the readable-content + blank-screenshot + floating-overlay floors
 * (the no-blue brand rule still applies). */
export const OVERLAY_NATIVE_OR_CANVAS_SLUGS = new Set([
  "builtin-chat",
  "builtin-phone",
  "builtin-messages",
  "builtin-camera",
  "plugin-phone-gui",
  "plugin-messages-gui",
]);

/** Verdict precedence for a view finding. */
export function computeVerdict(finding: VerdictFinding): AestheticVerdict {
  const exempt =
    finding.viewType === "tui" ||
    OVERLAY_NATIVE_OR_CANVAS_SLUGS.has(finding.slug);
  // A console error (a real crash signal) is broken for every view. Overlay-
  // native/canvas/terminal surfaces legitimately render little chrome text and
  // screenshot near-one-color, so the readable-content + blank-screenshot
  // floors are waived for them.
  if (
    finding.consoleErrors.length > 0 ||
    (!exempt &&
      (finding.qualityIssues.length > 0 || finding.readableChars < 10))
  ) {
    return "broken";
  }
  // TUI terminals are exempt from ALL color/light-surface rules: a terminal
  // renders an ANSI/slate palette by design. They pass once they render with no
  // real console errors.
  if (finding.viewType === "tui") {
    return "good";
  }
  // Overlay-native/canvas surfaces waive the floating-overlay + hover heuristics
  // (they own their surface), but the no-blue brand rule still holds.
  if (exempt) {
    return finding.blueColors.length > 0 ? "needs-work" : "good";
  }
  if (
    finding.blueColors.length > 0 ||
    finding.hoverViolations.length > 0 ||
    !finding.overlayPresent ||
    finding.overlayClearanceIssues.length > 0
  ) {
    return "needs-work";
  }
  // Off-scale border-radius (#8796) and divider-density over the "Her"-minimal
  // ceiling (#9950) are both SOFT signals: a non-blocking `needs-eyeball` records
  // them without destabilizing the green baseline.
  if (
    finding.borderRadiusViolations.length > 0 ||
    exceedsMinimalismBudget(finding)
  ) {
    return "needs-eyeball";
  }
  return "good";
}

/**
 * The worst verdict tolerated for a given `${slug}-${viewport}` key. Empty map =
 * zero debt. A `broken` entry tolerates a `broken` render for that view; because
 * `needs-work` is a strictly-lesser verdict, a `broken` entry ALSO tolerates a
 * `needs-work` for the same view (see {@link evaluateStrictGate}).
 */
export type AestheticVerdictDebt = Record<string, "broken" | "needs-work">;

/** The subset of a view audit finding the strict gate reads. The spec's fuller
 * `ViewFinding` (which carries `viewport` + `verdict`) is structurally
 * assignable to this. */
export interface GateFinding {
  slug: string;
  viewport: string;
  verdict: AestheticVerdict;
  consoleErrors: string[];
  qualityIssues: string[];
  /** Readable text length in the view root; ~0 means the view never painted. */
  readableChars: number;
}

export interface StrictGateOptions {
  /**
   * Gate undebted `broken` findings — the always-present strict fail. Defaults
   * to `true`: this function IS the strict gate. The spec threads the
   * `ELIZA_AUDIT_APP_STRICT` env flag through so a non-strict run can still read
   * the tally (`undebtedBroken`) without failing.
   */
  strict?: boolean;
  /**
   * ALSO gate undebted `needs-work` findings — the opt-in
   * `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=1` extension (#10710). Off by default.
   * Governed by the SAME {@link AestheticVerdictDebt} allowlist: a `needs-work`
   * OR a `broken` debt entry tolerates a `needs-work` for that slug-viewport.
   */
  needsWorkStrict?: boolean;
}

export interface StrictGateResult {
  /** `broken` findings whose slug-viewport is not debted as `broken`. */
  undebtedBroken: GateFinding[];
  /** `needs-work` findings with no debt entry (a `broken`/`needs-work` entry
   * tolerates them). Only gated when {@link StrictGateOptions.needsWorkStrict}. */
  undebtedNeedsWork: GateFinding[];
  /** True when the gate should fail the run under the supplied options. */
  failed: boolean;
  /** Human-readable failure detail, or "" when the gate passes. */
  message: string;
}

/**
 * Pure strict-gate evaluation for the all-views aesthetic audit (#9304, #10710).
 *
 * Extracted out of the Playwright spec so it is unit-testable without a live
 * `page`. `broken` (a real crash / blank render / console error / empty view)
 * fails the run when `strict` is on and the view is not covered by the
 * {@link AestheticVerdictDebt} allowlist; `needs-work` (design debt: blue /
 * orange-hover / off-token radius) only fails when the opt-in `needsWorkStrict`
 * is on and the view is likewise undebted. A `broken` debt entry is the stronger
 * grant and so also tolerates a `needs-work` for the same slug-viewport.
 */
export function evaluateStrictGate(
  findings: readonly GateFinding[],
  debt: AestheticVerdictDebt,
  opts: StrictGateOptions = {},
): StrictGateResult {
  const strict = opts.strict ?? true;
  const needsWorkStrict = opts.needsWorkStrict ?? false;
  const keyOf = (f: GateFinding): string => `${f.slug}-${f.viewport}`;

  const undebtedBroken = findings.filter(
    (f) => f.verdict === "broken" && debt[keyOf(f)] !== "broken",
  );
  // Either a `needs-work` or a `broken` debt entry tolerates a `needs-work`;
  // only a total absence of a debt entry leaves it undebted.
  const undebtedNeedsWork = findings.filter(
    (f) => f.verdict === "needs-work" && debt[keyOf(f)] === undefined,
  );

  const brokenFail = strict && undebtedBroken.length > 0;
  const needsWorkFail = needsWorkStrict && undebtedNeedsWork.length > 0;
  const failed = brokenFail || needsWorkFail;

  const sections: string[] = [];
  if (brokenFail) {
    const detail = undebtedBroken
      .map(
        (f) =>
          `  ${f.slug} @ ${f.viewport}: ${
            [...f.consoleErrors, ...f.qualityIssues].join("; ") ||
            `readableChars=${f.readableChars}`
          }`,
      )
      .join("\n");
    sections.push(
      `${undebtedBroken.length} non-exempt 'broken' view(s) not in ` +
        `AESTHETIC_VERDICT_DEBT:\n${detail}`,
    );
  }
  if (needsWorkFail) {
    const detail = undebtedNeedsWork
      .map((f) => `  ${f.slug} @ ${f.viewport}`)
      .join("\n");
    sections.push(
      `${undebtedNeedsWork.length} non-exempt 'needs-work' view(s) not in ` +
        `AESTHETIC_VERDICT_DEBT:\n${detail}`,
    );
  }
  const message = failed
    ? `[aesthetic-audit] STRICT gate failed:\n${sections.join("\n")}\n` +
      `Fix the view or, if genuinely accepted debt, add the slug-viewport key ` +
      `to AESTHETIC_VERDICT_DEBT (and shrink it over time).`
    : "";

  return { undebtedBroken, undebtedNeedsWork, failed, message };
}
