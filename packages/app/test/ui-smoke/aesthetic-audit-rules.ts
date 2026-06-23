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
  blueColors: string[];
  hoverViolations: string[];
  overlayPresent: boolean;
  borderRadiusViolations: string[];
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

/** Bucket a CSS color into a coarse brand category. */
export function bucket(color: string): Bucket {
  const rgb = parseRgb(color);
  if (!rgb) return "neutral";
  const [r, g, b, a] = rgb;
  if (a === 0) return "transparent";
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;
  if (lum < 0.08) return "black";
  if (lum > 0.95 && saturation < 0.05) return "white";
  if (saturation < 0.15) return "neutral";
  if (r > 200 && g > 90 && g < 200 && b < 100) return "orange";
  if (b > r + 20 && b > g + 10) return "blue";
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
    !finding.overlayPresent
  ) {
    return "needs-work";
  }
  // Off-scale border-radius is a soft signal (#8796 AC3 only asks the harness to
  // FLAG non-token radius): a non-blocking `needs-eyeball` records it without
  // destabilizing the green baseline.
  if (finding.borderRadiusViolations.length > 0) {
    return "needs-eyeball";
  }
  return "good";
}
