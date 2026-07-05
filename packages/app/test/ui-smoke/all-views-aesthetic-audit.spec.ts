/**
 * Playwright UI-smoke spec for the All Views Aesthetic Audit app flow using
 * the real renderer fixture.
 */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  type AestheticMetricBudget,
  type AestheticVerdictDebt,
  computeVerdict,
  evaluateAestheticMetricBudget,
  evaluateMinimalismRatchet,
  evaluateStrictGate,
  minimalismBaselineKey,
  OVERLAY_NATIVE_OR_CANVAS_SLUGS,
  parseMinimalismBaseline,
  parseNavigationTabPaths,
} from "./aesthetic-audit-rules";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";
import { VIEW_CASES } from "./plugin-view-cases";
import { VIEW_ROUTES } from "./view-routes";

// Strict-gate config (#9304). The audit was a pure reporter — `broken` /
// `needs-work` verdicts only landed in report.json and never failed a run, so a
// regressed view shipped green. With `ELIZA_AUDIT_APP_STRICT=1` the audit becomes
// a GATE that fails on any `broken` verdict (a real crash / blank render /
// console error / empty view) outside the shrinking debt allowlist below.
// `needs-work` (design debt: blue / orange-hover / off-token radius) is logged
// with a count but not hard-gated by default — opt in with
// `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=1` (#10710) once the current set is captured
// into AESTHETIC_VERDICT_DEBT from a clean CI run.
const AUDIT_STRICT = process.env.ELIZA_AUDIT_APP_STRICT === "1";
// Sub-pixel slack for the document-level horizontal-overflow invariant: fractional
// scrollWidth/innerWidth rounding can differ by ~1px on a healthy layout. A real
// un-contained overflow (WS5) blows past this comfortably.
const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 2;
const AUDIT_STRICT_NEEDS_WORK =
  process.env.ELIZA_AUDIT_APP_STRICT_NEEDS_WORK === "1";
// Key: `${slug}-${viewport}`. Value: the worst verdict currently tolerated for
// that view. Empty = zero debt (the INTERACTION_DEBT={}/MAX=0 convention).
const AESTHETIC_VERDICT_DEBT: AestheticVerdictDebt = {};

// "Her"-minimal ratchet baseline (#9950) — the committed per-view record of the
// existing divider-density debt (same idiom as
// packages/scripts/ui-determinism-baseline.json). A breaching view NOT in this
// file, or a baselined view that regressed past its recorded metrics +
// tolerance, is a BLOCKING `needs-work` and fails the run in afterAll —
// unconditionally, not just under ELIZA_AUDIT_APP_STRICT (same posture as the
// system-view metric budget throw below). Refresh deliberately from a run's
// report.json: `bun run --cwd packages/app audit:app:minimalism:update`.
const MINIMALISM_BASELINE_PATH = fileURLToPath(
  new URL("./aesthetic-minimalism-baseline.json", import.meta.url),
);
const MINIMALISM_BASELINE = parseMinimalismBaseline(
  readFileSync(MINIMALISM_BASELINE_PATH, "utf8"),
);

/**
 * App-side all-views aesthetic audit (#8796) — the agent app's equivalent of
 * cloud-frontend's `audit:cloud`. It walks EVERY view (built-in tabs + plugin
 * view bundles) across the design-review viewport matrix, captures rest +
 * primary-button hover screenshots, runs the blank/one-color analyzer, flags
 * brand-color violations (any blue, orange↔black hover), asserts the floating
 * chat overlay integrates, collects console errors, and writes a per-view
 * `manual-review/<slug>.md` verdict stub + `contact-sheet.html` +
 * `report.json`.
 *
 * It records findings for every view (no first-failure abort, so the 5-loop
 * grind can drive each to `good`), then gates in afterAll: an uncaught page
 * error fails the walk immediately; the system-view metric budgets and the
 * Her-minimal ratchet baseline (#9950) fail the run unconditionally; `broken`
 * verdicts fail under ELIZA_AUDIT_APP_STRICT=1. Output dir:
 * `aesthetic-audit-output/` (override with ELIZA_AUDIT_APP_DIR).
 *
 * Built-in views come from `@elizaos/ui` TAB_PATHS; plugin views from
 * `plugin-view-cases.ts` — the union so no view is silently omitted.
 */

// The canonical built-in route table (mirrors @elizaos/ui navigation TAB_PATHS;
// inlined to avoid importing the UI bundle into the Playwright runner).
// Full built-in coverage (#8796): mirrors @elizaos/ui navigation TAB_PATHS so the
// audit walks EVERY built-in view, not a subset. The `builtin coverage matches
// navigation TAB_PATHS` guard test below fails if this drifts from navigation.
const BUILTIN_TAB_PATHS: Record<string, string> = {
  chat: "/chat",
  phone: "/phone",
  messages: "/messages",
  contacts: "/contacts",
  camera: "/camera",
  tasks: "/apps/tasks",
  browser: "/browser",
  stream: "/stream",
  apps: "/apps",
  views: "/views",
  character: "/character",
  "character-select": "/character/select",
  automations: "/automations",
  inventory: "/wallet",
  documents: "/character/documents",
  "character-skills": "/character/skills",
  experience: "/character/experience",
  files: "/apps/files",
  plugins: "/apps/plugins",
  skills: "/apps/skills",
  "fine-tuning": "/apps/fine-tuning",
  trajectories: "/apps/trajectories",
  transcripts: "/apps/transcripts",
  relationships: "/apps/relationships",
  memories: "/apps/memories",
  rolodex: "/rolodex",
  runtime: "/apps/runtime",
  database: "/apps/database",
  desktop: "/desktop",
  settings: "/settings",
  logs: "/apps/logs",
  background: "/background",
};

// ── navigation TAB_PATHS coverage guard (#8796) ──────────────────────────────
// Parse the canonical TAB_PATHS straight from the @elizaos/ui navigation source
// (no UI-bundle import) so the guard reads the real table, not a stale copy.
const NAV_INDEX_PATH = fileURLToPath(
  new URL("../../../ui/src/navigation/index.ts", import.meta.url),
);

interface AuditCase {
  slug: string;
  path: string;
  viewType: "gui" | "tui";
  kind: "builtin" | "plugin";
}

function buildAuditCases(): AuditCase[] {
  const cases: AuditCase[] = [];
  for (const [id, viewPath] of Object.entries(BUILTIN_TAB_PATHS)) {
    cases.push({
      slug: `builtin-${id}`,
      path: viewPath,
      viewType: "gui",
      kind: "builtin",
    });
  }
  for (const view of VIEW_CASES) {
    cases.push({
      slug: `plugin-${view.id}-${view.viewType}`,
      path: view.path,
      viewType: view.viewType,
      kind: "plugin",
    });
  }
  return cases;
}

// {desktop,mobile} × {landscape,portrait}. "desktop" (landscape) and "mobile"
// (portrait) keep their original names so existing AESTHETIC_VERDICT_DEBT keys
// stay valid; the two added entries cover the previously-unverified orientations
// (portrait desktop/tablet, landscape phone) — see #9945.
const VIEWPORTS = [
  { name: "mobile-portrait", width: 390, height: 844 },
  { name: "mobile-landscape", width: 844, height: 390 },
  { name: "desktop-landscape", width: 1440, height: 900 },
  { name: "ipad-portrait", width: 820, height: 1180 },
] as const;

type AuditViewportName = (typeof VIEWPORTS)[number]["name"];

const SYSTEM_VIEW_SLUGS = [
  "builtin-chat",
  "builtin-phone",
  "builtin-apps",
  "builtin-character",
  "builtin-inventory",
  "builtin-browser",
  "builtin-stream",
  "builtin-automations",
  "builtin-settings",
] as const;

type SystemViewSlug = (typeof SYSTEM_VIEW_SLUGS)[number];

function budget(
  maxBorderDividerDensity: number,
  maxTextDensity: number,
  minWhitespaceRatio: number,
): AestheticMetricBudget {
  return {
    maxBorderDividerDensity,
    maxTextDensity,
    minWhitespaceRatio,
  };
}

function viewportBudgets(
  mobilePortrait: AestheticMetricBudget,
  mobileLandscape: AestheticMetricBudget,
  desktopLandscape: AestheticMetricBudget,
  ipadPortrait: AestheticMetricBudget,
): Record<AuditViewportName, AestheticMetricBudget> {
  return {
    "mobile-portrait": mobilePortrait,
    "mobile-landscape": mobileLandscape,
    "desktop-landscape": desktopLandscape,
    "ipad-portrait": ipadPortrait,
  };
}

// #9950 Her-minimal objective gate for the 9 ALL_TAB_GROUPS representatives:
// Chat, Phone, Springboard, Character, Wallet, Browser, Stream, Automations,
// Settings. These are intentionally per-view budgets, with conservative seed
// values from the current rendered tree; they should ratchet downward as the
// visual pass removes redundant borders/dividers and cramped text.
const SYSTEM_VIEW_METRIC_BUDGETS: Record<
  SystemViewSlug,
  Record<AuditViewportName, AestheticMetricBudget>
> = {
  "builtin-chat": viewportBudgets(
    budget(520, 34, 0.34),
    budget(560, 36, 0.28),
    budget(240, 24, 0.46),
    budget(360, 28, 0.42),
  ),
  "builtin-phone": viewportBudgets(
    budget(820, 28, 0.3),
    budget(900, 32, 0.26),
    budget(420, 24, 0.44),
    budget(560, 26, 0.38),
  ),
  "builtin-apps": viewportBudgets(
    budget(950, 50, 0.24),
    budget(1100, 60, 0.18),
    budget(520, 38, 0.38),
    budget(700, 45, 0.32),
  ),
  "builtin-character": viewportBudgets(
    budget(1150, 64, 0.18),
    budget(1280, 72, 0.14),
    budget(620, 48, 0.34),
    budget(800, 56, 0.28),
  ),
  "builtin-inventory": viewportBudgets(
    budget(900, 48, 0.22),
    budget(1050, 56, 0.16),
    budget(520, 36, 0.38),
    budget(700, 44, 0.32),
  ),
  "builtin-browser": viewportBudgets(
    budget(900, 42, 0.24),
    budget(1050, 50, 0.18),
    budget(520, 34, 0.38),
    budget(700, 40, 0.32),
  ),
  "builtin-stream": viewportBudgets(
    budget(850, 42, 0.24),
    budget(1000, 50, 0.18),
    budget(500, 34, 0.38),
    budget(650, 40, 0.32),
  ),
  "builtin-automations": viewportBudgets(
    budget(1250, 70, 0.16),
    budget(1400, 80, 0.12),
    budget(700, 54, 0.3),
    budget(900, 64, 0.24),
  ),
  "builtin-settings": viewportBudgets(
    budget(1150, 74, 0.16),
    budget(1300, 86, 0.12),
    budget(650, 58, 0.3),
    budget(850, 68, 0.12),
  ),
};

function isSystemViewSlug(slug: string): slug is SystemViewSlug {
  return (SYSTEM_VIEW_SLUGS as readonly string[]).includes(slug);
}

function systemMetricBudgetFor(
  slug: string,
  viewport: AuditViewportName,
): AestheticMetricBudget | null {
  return isSystemViewSlug(slug)
    ? SYSTEM_VIEW_METRIC_BUDGETS[slug][viewport]
    : null;
}

// ── Brand-color analysis: shared scans live in helpers/brand-color-scans ─────
interface ViewFinding {
  slug: string;
  viewport: string;
  path: string;
  consoleErrors: string[];
  blueColors: string[];
  hoverViolations: string[];
  /** Buttons the hover probe could not drive (hover timeout / detach) — a
   * harness failure surfaced as a finding, not silently swallowed. */
  hoverFailures: string[];
  borderRadiusViolations: string[];
  overlayPresent: boolean;
  overlayClearanceIssues: string[];
  viewType: "gui" | "tui";
  /** Readable text length in the view root; ~0 means the view never painted. */
  readableChars: number;
  /** documentElement.scrollWidth − innerWidth in px (≥0). >tolerance means the
   * page overflows horizontally at the document level — the WS5 transcript bug
   * (overflow-y:auto without overflow-x:hidden). An in-container scroll does not
   * expand documentElement.scrollWidth, so this isolates the un-contained bug. */
  horizontalOverflowPx: number;
  borderDividerCount: number;
  borderDividerDensity: number;
  textDensity: number;
  whitespaceRatio: number;
  /** Rendered viewport area in px² — the divider-density normalization basis. */
  viewportArea: number;
  /** The density probe crashed — surfaced as a finding, NOT scored as a
   * zero-density "perfectly minimal" pass (a crashed probe used to silently
   * satisfy the budget/ratchet). Non-empty means the metrics below are unknown. */
  densityProbeFailures: string[];
  minimalismBudget: AestheticMetricBudget | null;
  minimalismBudgetViolations: string[];
  /** Blocking Her-minimal ratchet violations vs the committed baseline (#9950). */
  minimalismRatchetViolations: string[];
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: "good" | "needs-work" | "needs-eyeball" | "broken";
}

/**
 * Scan the rendered DOM for border-radius values that are NOT on the token
 * radius scale: 3px (base.css collapses every --radius-* token to
 * --radius-xs: 3px — the eliza ultra-tight radius, #10710) plus the presets.ts
 * rem scale (radiusSm/Md/Lg/Xl/2xl/3xl → 6/8/12/16/20/24px at a 16px root).
 * Allowed alongside the token scale: `0px` (square) and full-round shapes
 * (`9999px`, `50%`, `100%`, circle pills). Everything else (e.g. ad-hoc
 * `10px`) is an off-scale value that should round to a token. Returns a
 * deduped list of offending computed values so the report can surface them;
 * ±1px tolerance absorbs sub-pixel rounding.
 */
async function collectBorderRadiusViolations(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    // Allowed px values. base.css collapses every radius token (--radius-sm
    // through --radius-3xl) to --radius-xs: 3px — the intended ultra-tight
    // eliza radius — so 3 is the canonical rendered value (#10710). The rem
    // scale (0.375rem=6 … 1.5rem=24) stays admitted for surfaces that read
    // presets.ts tokens directly rather than the base.css custom properties.
    // 32 is the floating chat capsule: ContinuousChatOverlay animates the
    // glass-panel radius 32→24 as the sheet opens (collapsed pill endpoint),
    // and the overlay is mounted on every view.
    const allowedPx = [0, 3, 6, 8, 12, 16, 20, 24, 32];
    const tolerance = 1;
    const isAllowed = (value: string): boolean => {
      const v = value.trim().toLowerCase();
      if (!v || v === "none" || v === "auto") return true;
      // A shorthand can list up to 4 corners (space- or slash-separated); each
      // corner must be on-scale for the element to pass.
      const parts = v.split(/[\s/]+/).filter(Boolean);
      if (parts.length > 1) return parts.every((p) => isAllowed(p));
      // Full-round shapes: explicit pill radius or any percentage ≥ 50% (a
      // 50%/100% radius renders a circle/pill, which is a deliberate shape).
      if (v === "9999px" || v === "50%" || v === "100%") return true;
      const pctMatch = v.match(/^(\d+\.?\d*)%$/);
      if (pctMatch) return Number(pctMatch[1]) >= 50;
      const pxMatch = v.match(/^(\d+\.?\d*)px$/);
      if (pxMatch) {
        const px = Number(pxMatch[1]);
        if (px >= 1000) return true; // any huge px = pill rounding
        return allowedPx.some((a) => Math.abs(px - a) <= tolerance);
      }
      // Unknown unit/keyword we cannot evaluate → don't flag (avoid noise).
      return true;
    };
    const out = new Set<string>();
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      const cs = getComputedStyle(node as Element);
      // borderRadius is the shorthand; sample a corner too in case the
      // shorthand serializes to "" (mixed corners on some engines).
      const candidates = [cs.borderRadius, cs.borderTopLeftRadius];
      for (const value of candidates) {
        if (value && !isAllowed(value)) out.add(value);
      }
    }
    return Array.from(out);
  });
  return raw;
}

interface AestheticDensityMetrics {
  borderDividerCount: number;
  borderDividerDensity: number;
  textDensity: number;
  whitespaceRatio: number;
  /** Viewport px² the densities were normalized by. 0 = measurement failed. */
  viewportArea: number;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

async function collectAestheticDensityMetrics(
  page: Page,
): Promise<AestheticDensityMetrics> {
  return page.evaluate(() => {
    const viewportWidth = Math.max(
      document.documentElement.clientWidth,
      window.innerWidth,
      1,
    );
    const viewportHeight = Math.max(
      document.documentElement.clientHeight,
      window.innerHeight,
      1,
    );
    const viewportArea = viewportWidth * viewportHeight;
    const cellSize = 10;
    const cols = Math.ceil(viewportWidth / cellSize);
    const rows = Math.ceil(viewportHeight / cellSize);
    const occupied = new Uint8Array(cols * rows);

    const alphaOf = (color: string): number => {
      const c = color.trim().toLowerCase();
      if (!c || c === "transparent") return 0;
      const rgb = c.match(
        /^rgba?\(\s*\d+\.?\d*\s*,\s*\d+\.?\d*\s*,\s*\d+\.?\d*(?:\s*,\s*(\d+\.?\d*))?\s*\)$/,
      );
      if (rgb) return rgb[1] === undefined ? 1 : Number(rgb[1]);
      // Computed CSS color functions are already resolved by Chromium for most
      // values; if one remains, treat it as visible rather than silently missing
      // a divider/background.
      return 1;
    };

    const rectIntersectsViewport = (rect: DOMRect): boolean =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;

    const markRect = (rect: DOMRect): void => {
      if (!rectIntersectsViewport(rect)) return;
      const left = Math.max(0, Math.floor(rect.left / cellSize));
      const top = Math.max(0, Math.floor(rect.top / cellSize));
      const right = Math.min(cols - 1, Math.floor((rect.right - 1) / cellSize));
      const bottom = Math.min(
        rows - 1,
        Math.floor((rect.bottom - 1) / cellSize),
      );
      for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
          occupied[y * cols + x] = 1;
        }
      }
    };

    const visibleElement = (element: Element): boolean => {
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0.02
      ) {
        return false;
      }
      return Array.from(element.getClientRects()).some(rectIntersectsViewport);
    };

    let textChars = 0;
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const raw = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
          if (!raw) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript") {
            return NodeFilter.FILTER_REJECT;
          }
          // The floating chat shell is mounted over every GUI view and has its
          // own overlay presence/clearance checks below. Keep transient overlay
          // copy out of per-view text-density ratchets so a global boot banner
          // does not make unrelated plugin views look more cramped.
          if (
            parent.closest(
              "[data-continuous-chat-overlay], [data-testid='continuous-chat-overlay']",
            )
          ) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest("[data-aesthetic-audit-ignore-text-density]")) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!visibleElement(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const isInsideGlobalOverlay = (element: Element): boolean =>
      Boolean(
        element.closest(
          "[data-continuous-chat-overlay], [data-testid='continuous-chat-overlay']",
        ),
      );

    for (
      let textNode = walker.nextNode();
      textNode;
      textNode = walker.nextNode()
    ) {
      const text = textNode.textContent?.trim().replace(/\s+/g, " ") ?? "";
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const rects = Array.from(range.getClientRects()).filter(
        rectIntersectsViewport,
      );
      range.detach();
      if (rects.length === 0) continue;
      textChars += text.length;
      for (const rect of rects) markRect(rect);
    }

    let borderDividerCount = 0;
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      if (isInsideGlobalOverlay(node)) continue;
      if (!visibleElement(node)) continue;
      const style = getComputedStyle(node);
      const rects = Array.from(node.getClientRects()).filter(
        rectIntersectsViewport,
      );
      if (rects.length === 0) continue;

      const sideWidths = [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ];
      const sideStyles = [
        style.borderTopStyle,
        style.borderRightStyle,
        style.borderBottomStyle,
        style.borderLeftStyle,
      ];
      const sideColors = [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ];
      let visibleBorderSides = 0;
      for (let i = 0; i < sideWidths.length; i += 1) {
        const width = Number.parseFloat(sideWidths[i] || "0");
        if (
          width >= 0.5 &&
          sideStyles[i] !== "none" &&
          sideStyles[i] !== "hidden" &&
          alphaOf(sideColors[i]) > 0.02
        ) {
          visibleBorderSides += 1;
        }
      }
      borderDividerCount += visibleBorderSides;

      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute("role");
      const primaryRect = rects[0];
      const thinHorizontal = primaryRect.height <= 2 && primaryRect.width >= 24;
      const thinVertical = primaryRect.width <= 2 && primaryRect.height >= 24;
      const hasDividerBackground =
        alphaOf(style.backgroundColor) > 0.02 &&
        (thinHorizontal || thinVertical);
      if (tag === "hr" || role === "separator" || hasDividerBackground) {
        borderDividerCount += 1;
      }

      const hasVisibleBackground = alphaOf(style.backgroundColor) > 0.02;
      const hasShadow = style.boxShadow !== "none";
      const isMedia = /^(canvas|img|picture|svg|video)$/.test(tag);
      const isControl = node.matches(
        "button, input, textarea, select, summary, [role='button'], [role='tab'], [role='switch'], [role='checkbox'], [contenteditable='true']",
      );
      const largestRectArea = Math.max(
        ...rects.map((rect) => rect.width * rect.height),
      );
      const isPageShell =
        node === document.body ||
        node.id === "root" ||
        tag === "main" ||
        largestRectArea > viewportArea * 0.72;
      if (
        !isPageShell &&
        (visibleBorderSides > 0 ||
          hasDividerBackground ||
          hasShadow ||
          isMedia ||
          isControl ||
          (hasVisibleBackground && largestRectArea <= viewportArea * 0.45))
      ) {
        for (const rect of rects) markRect(rect);
      }
    }

    let occupiedCells = 0;
    for (const cell of occupied) occupiedCells += cell;
    const whitespaceRatio =
      occupied.length === 0 ? 1 : 1 - occupiedCells / occupied.length;

    return {
      borderDividerCount,
      borderDividerDensity: Number(
        (borderDividerCount / (viewportArea / 1_000_000)).toFixed(4),
      ),
      textDensity: Number((textChars / (viewportArea / 10_000)).toFixed(4)),
      whitespaceRatio: Number(whitespaceRatio.toFixed(4)),
      viewportArea,
    };
  });
}

async function collectOverlayClearanceIssues(
  page: Page,
  overlaySelector: string,
): Promise<string[]> {
  return page.evaluate((selector) => {
    const overlay = document.querySelector(selector);
    if (!overlay) return [];
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const issues: string[] = [];
    const isVisible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0.02
      );
    };
    const overlayRects = Array.from(
      overlay.querySelectorAll(
        [
          "[data-testid='chat-sheet']",
          "[data-testid='chat-pill']",
          "[data-testid='chat-sheet-grabber']",
          "button",
          "textarea",
          "input",
          "[role='button']",
        ].join(","),
      ),
    )
      .filter((element) => {
        if (!isVisible(element)) return false;
        const style = getComputedStyle(element);
        const testId = element.getAttribute("data-testid");
        return style.pointerEvents !== "none" || testId === "chat-sheet";
      })
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    const rects =
      overlayRects.length > 0
        ? overlayRects
        : [overlay.getBoundingClientRect()];
    const margin = 1;
    for (const rect of rects) {
      if (
        rect.left < -margin ||
        rect.top < -margin ||
        rect.right > viewportWidth + margin ||
        rect.bottom > viewportHeight + margin
      ) {
        issues.push(
          `overlay clipped (${Math.round(rect.left)},${Math.round(
            rect.top,
          )} ${Math.round(rect.width)}x${Math.round(
            rect.height,
          )} in ${viewportWidth}x${viewportHeight})`,
        );
        break;
      }
    }

    const overlapArea = (a: DOMRect, b: DOMRect): number => {
      const width = Math.max(
        0,
        Math.min(a.right, b.right) - Math.max(a.left, b.left),
      );
      const height = Math.max(
        0,
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
      );
      return width * height;
    };
    const isUsableRect = (rect: DOMRect): boolean =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth &&
      rect.top < viewportHeight;
    const intersectRects = (a: DOMRect, b: DOMRect): DOMRect => {
      const left = Math.max(a.left, b.left);
      const top = Math.max(a.top, b.top);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return new DOMRect(
        left,
        top,
        Math.max(0, right - left),
        Math.max(0, bottom - top),
      );
    };
    const viewportRect = new DOMRect(0, 0, viewportWidth, viewportHeight);
    const clipRectToVisibleAncestors = (
      rect: DOMRect,
      owner: Element,
    ): DOMRect => {
      let clipped = intersectRects(rect, viewportRect);
      let ancestor: Element | null = owner.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const style = getComputedStyle(ancestor);
        if (
          /(auto|scroll|hidden|clip)/.test(
            `${style.overflowX} ${style.overflowY}`,
          )
        ) {
          clipped = intersectRects(clipped, ancestor.getBoundingClientRect());
          if (!isUsableRect(clipped)) return clipped;
        }
        ancestor = ancestor.parentElement;
      }
      return clipped;
    };
    const collectControlVisualRects = (control: Element): DOMRect[] => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim()) continue;
        const owner =
          node.parentElement && control.contains(node.parentElement)
            ? node.parentElement
            : control;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(
          ...Array.from(range.getClientRects()).map((rect) =>
            clipRectToVisibleAncestors(rect, owner),
          ),
        );
        range.detach();
      }
      for (const element of Array.from(
        control.querySelectorAll(
          "svg, img, canvas, video, input, textarea, select, [role='switch'], [role='checkbox']",
        ),
      )) {
        if (!isVisible(element)) continue;
        rects.push(
          clipRectToVisibleAncestors(element.getBoundingClientRect(), element),
        );
      }
      return rects.filter(isUsableRect);
    };
    const controls = Array.from(
      document.querySelectorAll(
        "button, a[href], input, textarea, select, summary, [role='button'], [role='link'], [role='tab'], [role='switch'], [role='checkbox'], [contenteditable='true']",
      ),
    ).slice(0, 400);
    for (const control of controls) {
      if (overlay.contains(control) || control.contains(overlay)) continue;
      const style = getComputedStyle(control);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") <= 0.02
      ) {
        continue;
      }
      const rect = control.getBoundingClientRect();
      const visibleControlRect = clipRectToVisibleAncestors(rect, control);
      if (!isUsableRect(visibleControlRect)) continue;
      const visualRects = collectControlVisualRects(control);
      const testRects =
        visualRects.length > 0 ? visualRects : [visibleControlRect];
      const visualArea = testRects.reduce(
        (total, visualRect) => total + visualRect.width * visualRect.height,
        0,
      );
      const area = testRects.reduce(
        (total, visualRect) =>
          total +
          rects.reduce(
            (rectTotal, overlayRect) =>
              rectTotal + overlapArea(overlayRect, visualRect),
            0,
          ),
        0,
      );
      // Ignore tiny edge grazes: they are usually fractional text/control rect
      // slivers from the floating composer sitting near the content, not a
      // blocked tap target. Real obstruction still trips either the absolute or
      // relative threshold comfortably.
      if (area < 160 || area < visualArea * 0.25) continue;
      const label =
        (
          control.getAttribute("aria-label") ||
          control.textContent?.trim().replace(/\s+/g, " ") ||
          control.getAttribute("data-testid") ||
          control.tagName.toLowerCase()
        )
          .slice(0, 36)
          .trim() || control.tagName.toLowerCase();
      issues.push(`overlay overlaps "${label}" (${Math.round(area)}px²)`);
      if (issues.length >= 5) break;
    }
    return issues;
  }, overlaySelector);
}

function renderManualReviewStub(finding: ViewFinding): string {
  const lines = [
    `# ${finding.slug} (${finding.viewport})`,
    "",
    `- **path:** \`${finding.path}\``,
    `- **verdict:** ${finding.verdict}`,
    `- **console errors:** ${finding.consoleErrors.length}`,
    `- **blue colors (banned):** ${finding.blueColors.length ? finding.blueColors.join(", ") : "none"}`,
    `- **border-radius violations (off-token):** ${finding.borderRadiusViolations.length ? finding.borderRadiusViolations.join(", ") : "none"}`,
    `- **orange↔black hover violations:** ${finding.hoverViolations.length ? finding.hoverViolations.join("; ") : "none"}`,
    `- **hover probe failures:** ${finding.hoverFailures.length ? finding.hoverFailures.join("; ") : "none"}`,
    `- **density probe failures:** ${finding.densityProbeFailures.length ? finding.densityProbeFailures.join("; ") : "none"}`,
    `- **floating chat overlay present:** ${finding.overlayPresent ? "yes" : "NO"}`,
    `- **floating chat overlay clearance:** ${finding.overlayClearanceIssues.length ? finding.overlayClearanceIssues.join("; ") : "clear"}`,
    `- **readable content chars:** ${finding.readableChars}`,
    `- **horizontal overflow:** ${finding.horizontalOverflowPx}px${finding.horizontalOverflowPx > HORIZONTAL_OVERFLOW_TOLERANCE_PX ? " ⚠ OVERFLOW" : ""}`,
    `- **border/divider density:** ${roundMetric(finding.borderDividerDensity)} (${finding.borderDividerCount} edges / 1M px)`,
    `- **text density:** ${roundMetric(finding.textDensity)} chars / 10K px`,
    `- **whitespace ratio:** ${roundMetric(finding.whitespaceRatio)}`,
    `- **minimalism budget:** ${finding.minimalismBudget ? (finding.minimalismBudgetViolations.length ? finding.minimalismBudgetViolations.join("; ") : "pass") : "n/a"}`,
    `- **minimalism ratchet (#9950):** ${finding.minimalismRatchetViolations.length ? finding.minimalismRatchetViolations.join("; ") : "pass"}`,
    `- **screenshot quality issues:** ${finding.qualityIssues.length ? finding.qualityIssues.join("; ") : "none"}`,
    "",
    "## Notes",
    "",
    "_Fill in: visual issues, layout breaks, e2e gaps. Set verdict to one of:_",
    "_`good` · `needs-work` · `needs-eyeball` · `broken`._",
    "",
  ];
  return lines.join("\n");
}

// Views where the surface IS the experience (the chat overlay itself, a phone
// dialer, or a fullscreen game/canvas), per the #8796 open questions: only the
// chrome is in scope, so they're exempt from the readable-content + floating-
// overlay-clearance + light-surface checks. They still must not crash, log
// console errors, render fully blank, or use blue.
const findings: ViewFinding[] = [];

test.describe("all-views aesthetic audit (#8796)", () => {
  const outputDir =
    process.env.ELIZA_AUDIT_APP_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output");

  // Coverage guard: the audit must walk EVERY built-in view. Fails on a phantom
  // key, a path drift, or any distinct navigation route the audit doesn't cover —
  // so a newly-added tab fails the suite until it is added to BUILTIN_TAB_PATHS.
  test("builtin coverage matches navigation TAB_PATHS", () => {
    const navPaths = parseNavigationTabPaths(
      readFileSync(NAV_INDEX_PATH, "utf8"),
    );
    const navKeys = new Set(Object.keys(navPaths));
    const navDistinctPaths = new Set(Object.values(navPaths));
    const inlinedKeys = Object.keys(BUILTIN_TAB_PATHS);
    const inlinedPaths = new Set(Object.values(BUILTIN_TAB_PATHS));

    const phantomKeys = inlinedKeys.filter((k) => !navKeys.has(k));
    expect(
      phantomKeys,
      `audit BUILTIN_TAB_PATHS has keys not in navigation TAB_PATHS: ${phantomKeys.join(", ")}`,
    ).toEqual([]);

    const mismatched = inlinedKeys.filter(
      (k) => BUILTIN_TAB_PATHS[k] !== navPaths[k],
    );
    expect(
      mismatched,
      `audit BUILTIN_TAB_PATHS path drift vs navigation: ${mismatched.join(", ")}`,
    ).toEqual([]);

    const uncovered = [...navDistinctPaths].filter((p) => !inlinedPaths.has(p));
    expect(
      uncovered,
      `navigation TAB_PATHS adds routes the audit does not cover: ${uncovered.join(", ")}`,
    ).toEqual([]);

    // Same guard for the shared `./view-routes` VIEW_ROUTES table (consumed by
    // all-views-interaction.spec.ts and tap-target-geometry-all-views.spec.ts):
    // it must stay a superset of navigation TAB_PATHS — agree on the path for
    // every shared id and cover every distinct navigation route. Extra
    // VIEW_ROUTES entries (non-tab surfaces like /settings/voice) are allowed.
    const viewRoutePaths = Object.fromEntries(
      VIEW_ROUTES.map((r) => [r.id, r.path]),
    );
    const viewRouteDistinctPaths = new Set(Object.values(viewRoutePaths));

    const viewRouteMismatched = Object.keys(viewRoutePaths).filter(
      (k) => k in navPaths && viewRoutePaths[k] !== navPaths[k],
    );
    expect(
      viewRouteMismatched,
      `view-routes VIEW_ROUTES path drift vs navigation: ${viewRouteMismatched.join(", ")}`,
    ).toEqual([]);

    const viewRouteUncovered = [...navDistinctPaths].filter(
      (p) => !viewRouteDistinctPaths.has(p),
    );
    expect(
      viewRouteUncovered,
      `navigation TAB_PATHS adds routes view-routes VIEW_ROUTES does not cover: ${viewRouteUncovered.join(", ")}`,
    ).toEqual([]);
  });

  for (const view of buildAuditCases()) {
    for (const vp of VIEWPORTS) {
      test(`${view.slug} ${vp.name}`, async ({ page }) => {
        const reviewDir = path.join(outputDir, "manual-review");
        const shotDir = path.join(outputDir, vp.name);
        await mkdir(reviewDir, { recursive: true });
        await mkdir(shotDir, { recursive: true });

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          // The deterministic stub backend answers some routes with 501 / no
          // network; those console errors are EXPECTED in this harness (same
          // rationale as builtin-views-visual.spec) and are not a quality
          // signal — only real, non-network console errors count.
          if (
            /\b501\b|failed to (load|fetch)|net::err|networkerror|status (of )?50\d|err_/i.test(
              text,
            )
          ) {
            return;
          }
          consoleErrors.push(text);
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await seedAppStorage(page);
        await installDefaultAppRoutes(page);
        await openAppPath(page, view.path);

        // Robust readiness under sustained sequential load: most views render
        // <main>, but chat/phone/etc. render straight into #root with no <main>.
        // Poll for the view to actually PAINT (readable content or the floating
        // overlay) rather than sampling a still-blank frame — a single shared
        // dev server slows late in the walk, so a fixed short wait yields false
        // blanks. Non-fatal: a view that never paints is recorded as a finding.
        const viewRoot = page.locator("main, #root").first();
        await viewRoot
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => {});
        const overlayRequired =
          view.viewType !== "tui" &&
          !OVERLAY_NATIVE_OR_CANVAS_SLUGS.has(view.slug);
        const overlaySelector = [
          "[data-continuous-chat-overlay]",
          "[data-testid='continuous-chat-overlay']",
          "[data-testid='chat-sheet']",
          "[data-testid='chat-pill']",
          "[data-testid='chat-composer-textarea']",
        ].join(", ");
        const readPaint = async (): Promise<{
          readableChars: number;
          overlayPresent: boolean;
        }> => {
          const readableChars = await viewRoot
            .evaluate(
              (root) =>
                (root as HTMLElement).innerText.trim().replace(/\s+/g, " ")
                  .length,
            )
            .catch(() => 0);
          const overlayPresent = await page
            .locator(overlaySelector)
            .evaluateAll((nodes) =>
              nodes.some((node) => {
                const el = node as HTMLElement;
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  Number(style.opacity || "1") !== 0 &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              }),
            )
            .catch(() => false);
          return { readableChars, overlayPresent };
        };
        let paint = await readPaint();
        for (
          let attempt = 0;
          attempt < 12 &&
          (paint.readableChars < 10 ||
            (overlayRequired && !paint.overlayPresent));
          attempt += 1
        ) {
          await page.waitForTimeout(1000);
          paint = await readPaint();
        }
        const { readableChars, overlayPresent } = paint;

        // Document-level horizontal-overflow invariant (WS5). Measured, not
        // swallowed: a genuine measurement failure throws and fails the view
        // rather than fabricating 0 ("no overflow" = healthy) from a catch.
        const horizontalOverflowPx = await page.evaluate(() => {
          const de = document.documentElement;
          const scrollWidth = Math.max(
            de.scrollWidth,
            document.body?.scrollWidth ?? 0,
          );
          const innerWidth = window.innerWidth || de.clientWidth;
          return Math.max(0, Math.round(scrollWidth - innerWidth));
        });

        // Screenshot with a blank-retry (mirrors captureScreenshotWithQualityRetry):
        // re-sample a few times so a momentarily-unpainted frame is not recorded
        // as a one-color "broken".
        const restPath = path.join(shotDir, `${view.slug}.png`);
        let buffer = await page.screenshot({ path: restPath, fullPage: false });
        let quality = await analyzeScreenshot(buffer).catch(() => null);
        for (
          let attempt = 0;
          attempt < 3 && quality && quality.colorBuckets <= 1;
          attempt += 1
        ) {
          await page.waitForTimeout(800);
          buffer = await page.screenshot({ path: restPath, fullPage: false });
          quality = await analyzeScreenshot(buffer).catch(() => null);
        }
        const qualityIssues = quality
          ? screenshotQualityIssues(`${view.slug} ${vp.name}`, quality)
          : [];

        const blueColors = await collectBlueColors(page).catch(() => []);
        const { violations: hoverViolations, hoverFailures } =
          await collectHoverViolations(page).catch((error: unknown) => ({
            violations: [],
            // The whole hover scan failing is itself a finding, not a silent pass.
            hoverFailures: [
              `hover scan failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            ],
          }));
        const borderRadiusViolations = await collectBorderRadiusViolations(
          page,
        ).catch(() => []);
        const overlayClearanceIssues = overlayPresent
          ? await collectOverlayClearanceIssues(page, overlaySelector).catch(
              () => [],
            )
          : [];
        // A crashed density probe must NOT read as zero-density "perfectly
        // minimal" — that silently satisfied both the budget and the ratchet.
        // Record the failure (surfaced like hoverFailures) and skip scoring the
        // placeholder zeros so the probe crash can never manufacture a pass.
        const densityProbeFailures: string[] = [];
        const densityMetrics = await collectAestheticDensityMetrics(page).catch(
          (error: unknown) => {
            densityProbeFailures.push(
              `density probe failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            );
            return {
              borderDividerCount: 0,
              borderDividerDensity: 0,
              textDensity: 0,
              whitespaceRatio: 1,
              viewportArea: 0,
            };
          },
        );
        const densityProbeOk = densityProbeFailures.length === 0;
        const minimalismBudget = systemMetricBudgetFor(view.slug, vp.name);
        const minimalismBudgetViolations =
          minimalismBudget && densityProbeOk
            ? evaluateAestheticMetricBudget(densityMetrics, minimalismBudget)
            : [];

        const base = {
          slug: view.slug,
          viewport: vp.name,
          path: view.path,
          viewType: view.viewType,
          consoleErrors,
          blueColors,
          hoverViolations,
          hoverFailures,
          borderRadiusViolations,
          overlayPresent,
          overlayClearanceIssues,
          readableChars,
          horizontalOverflowPx,
          ...densityMetrics,
          densityProbeFailures,
          minimalismBudget,
          minimalismBudgetViolations,
          quality,
          qualityIssues,
        };
        // Her-minimal ratchet (#9950): blocks a NEW density breach (no baseline
        // entry) or a baselined breach that regressed past tolerance. Only when
        // the probe produced real metrics — a crashed probe's zero-density
        // placeholder must not manufacture a ratchet pass.
        const minimalismRatchetViolations = densityProbeOk
          ? evaluateMinimalismRatchet(
              base,
              MINIMALISM_BASELINE.views[
                minimalismBaselineKey(view.slug, vp.name)
              ],
            )
          : [];
        const finding: ViewFinding = {
          ...base,
          minimalismRatchetViolations,
          verdict: computeVerdict({ ...base, minimalismRatchetViolations }),
        };
        findings.push(finding);

        await writeFile(
          path.join(reviewDir, `${view.slug}-${vp.name}.md`),
          renderManualReviewStub(finding),
          "utf8",
        );

        // Only a real crash fails the walk; design findings live in the report.
        expect(
          pageErrors,
          `${view.slug} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);

        // Horizontal-overflow invariant is always recorded (report.json +
        // mvp-visual-verify consumes it) and hard-gated only under strict, so the
        // reporter run never turns green-but-overflowing into a soft finding.
        if (AUDIT_STRICT) {
          expect(
            horizontalOverflowPx,
            `${view.slug} ${vp.name} overflows horizontally by ${horizontalOverflowPx}px ` +
              `(documentElement.scrollWidth exceeds innerWidth — likely overflow-y ` +
              `without overflow-x:hidden)`,
          ).toBeLessThanOrEqual(HORIZONTAL_OVERFLOW_TOLERANCE_PX);
        }
      });
    }
  }

  test.afterAll(async () => {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "report.json"),
      JSON.stringify(findings, null, 2),
      "utf8",
    );
    const rows = findings
      .map(
        (f) =>
          `<tr><td>${f.slug}</td><td>${f.viewport}</td><td>${f.verdict}</td>` +
          `<td>${f.consoleErrors.length}</td><td>${f.blueColors.length}</td>` +
          `<td>${f.borderRadiusViolations.length}</td>` +
          `<td>${f.hoverViolations.length}${f.hoverFailures.length ? ` (+${f.hoverFailures.length} probe-failed)` : ""}</td><td>${f.overlayPresent ? "✓" : "✗"}</td>` +
          `<td>${f.overlayClearanceIssues.length}</td>` +
          `<td>${roundMetric(f.borderDividerDensity)}</td>` +
          `<td>${roundMetric(f.textDensity)}</td>` +
          `<td>${roundMetric(f.whitespaceRatio)}</td>` +
          `<td>${f.minimalismBudgetViolations.length ? f.minimalismBudgetViolations.join("<br>") : "✓"}</td>` +
          `<td>${f.minimalismRatchetViolations.length ? f.minimalismRatchetViolations.join("<br>") : "✓"}</td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>app aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>view</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>radius</th><th>hover</th>` +
        `<th>overlay</th><th>overlay clearance</th><th>border/divider density</th>` +
        `<th>text density</th><th>whitespace ratio</th><th>minimalism budget</th>` +
        `<th>minimalism ratchet</th></tr>` +
        `${rows}</table>`,
      "utf8",
    );

    // Gate (#9304, #10710). Always log the verdict tally; the strict fail lives
    // in the pure `evaluateStrictGate` (unit-tested in test/audit): it fails on
    // any undebted `broken` view when `strict` is on, and — with
    // `ELIZA_AUDIT_APP_STRICT_NEEDS_WORK=1` — on any undebted `needs-work` too.
    const broken = findings.filter((f) => f.verdict === "broken");
    const needsWork = findings.filter((f) => f.verdict === "needs-work");
    const minimalismBudgetFailures = findings.filter(
      (f) => f.minimalismBudgetViolations.length > 0,
    );
    const gate = evaluateStrictGate(findings, AESTHETIC_VERDICT_DEBT, {
      strict: AUDIT_STRICT,
      needsWorkStrict: AUDIT_STRICT_NEEDS_WORK,
    });
    const minimalismRatchetFailures = findings.filter(
      (f) => f.minimalismRatchetViolations.length > 0,
    );
    const hoverProbeFailures = findings.filter(
      (f) => f.hoverFailures.length > 0,
    );
    const densityProbeFailures = findings.filter(
      (f) => f.densityProbeFailures.length > 0,
    );
    console.log(
      `[aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length} ` +
        `minimalism-budget-failures=${minimalismBudgetFailures.length} ` +
        `minimalism-ratchet-failures=${minimalismRatchetFailures.length} ` +
        `hover-probe-failures=${hoverProbeFailures.length} ` +
        `density-probe-failures=${densityProbeFailures.length} ` +
        `(strict=${AUDIT_STRICT}, needs-work-strict=${AUDIT_STRICT_NEEDS_WORK}, ` +
        `undebted-broken=${gate.undebtedBroken.length}, ` +
        `undebted-needs-work=${gate.undebtedNeedsWork.length})`,
    );
    if (hoverProbeFailures.length > 0) {
      // Surfaced, not gated: a hover probe that cannot drive a button is a
      // harness reliability signal, recorded per view in report.json and the
      // manual-review stubs.
      const detail = hoverProbeFailures
        .map(
          (f) => `  ${f.slug} @ ${f.viewport}: ${f.hoverFailures.join("; ")}`,
        )
        .join("\n");
      console.log(`[aesthetic-audit] hover probe failures:\n${detail}`);
    }
    if (minimalismBudgetFailures.length > 0) {
      const detail = minimalismBudgetFailures
        .map(
          (f) =>
            `  ${f.slug} @ ${f.viewport}: ${f.minimalismBudgetViolations.join(
              "; ",
            )}`,
        )
        .join("\n");
      throw new Error(
        `[aesthetic-audit] Minimalism metric budget failed for ` +
          `${minimalismBudgetFailures.length} system view(s):\n${detail}\n` +
          `Update the UI to reduce divider/text density or increase whitespace; ` +
          `only adjust SYSTEM_VIEW_METRIC_BUDGETS when intentionally ratcheting ` +
          `from a fresh clean baseline.`,
      );
    }
    // Her-minimal ratchet gate (#9950) — unconditional, like the system-view
    // budget above: a NEW divider-density breach, or a baselined breach that
    // regressed past its recorded metrics + tolerance, fails the run.
    if (minimalismRatchetFailures.length > 0) {
      const detail = minimalismRatchetFailures
        .map(
          (f) =>
            `  ${f.slug} @ ${f.viewport}: ${f.minimalismRatchetViolations.join("; ")}`,
        )
        .join("\n");
      throw new Error(
        `[aesthetic-audit] Her-minimal ratchet failed for ` +
          `${minimalismRatchetFailures.length} view(s):\n${detail}\n` +
          `Remove redundant borders/dividers (or de-cramp the layout) so the ` +
          `view drops back under its baseline. Only after an intentional, ` +
          `reviewed design change, refresh the committed baseline from this ` +
          `run's report.json:\n` +
          `  bun run --cwd packages/app audit:app:minimalism:update`,
      );
    }
    if (gate.failed) {
      throw new Error(gate.message);
    }
  });
});
