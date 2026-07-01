import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bucket,
  computeVerdict,
  MINIMALISM_DENSITY_CEILING,
  minimalismDensity,
  parseNavigationTabPaths,
} from "./aesthetic-audit-rules";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";
import { VIEW_CASES } from "./plugin-view-cases";

// Strict-gate config (#9304). The audit was a pure reporter — `broken` /
// `needs-work` verdicts only landed in report.json and never failed a run, so a
// regressed view shipped green. With `ELIZA_AUDIT_APP_STRICT=1` the audit becomes
// a GATE that fails on any `broken` verdict (a real crash / blank render /
// console error / empty view) outside the shrinking debt allowlist below.
// `needs-work` (design debt: blue / orange-hover / off-token radius) is logged
// with a count but not hard-gated yet — capture the current set into
// AESTHETIC_VERDICT_DEBT from a clean CI run, then tighten this to gate it too.
const AUDIT_STRICT = process.env.ELIZA_AUDIT_APP_STRICT === "1";
// Key: `${slug}-${viewport}`. Value: the worst verdict currently tolerated for
// that view. Empty = zero debt (the INTERACTION_DEBT={}/MAX=0 convention).
const AESTHETIC_VERDICT_DEBT: Record<string, "broken" | "needs-work"> = {};

/**
 * App-side all-views aesthetic audit (#8796) — the agent app's equivalent of
 * cloud-frontend's `audit:cloud`. It walks EVERY view (built-in tabs + plugin
 * view bundles) at desktop + mobile, captures rest + primary-button hover
 * screenshots, runs the blank/one-color analyzer, flags brand-color violations
 * (any blue, orange↔black hover), asserts the floating chat overlay integrates,
 * collects console errors, and writes a per-view `manual-review/<slug>.md`
 * verdict stub + `contact-sheet.html` + `report.json`.
 *
 * It is a REPORTER, not a first-failure gate: it records findings for every
 * view (so the 5-loop grind can drive each to `good`) and only fails the run on
 * an uncaught page error (a real crash). Output dir:
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
  companion: "/companion",
  stream: "/stream",
  apps: "/apps",
  views: "/views",
  character: "/character",
  "character-select": "/character/select",
  automations: "/automations",
  inventory: "/wallet",
  documents: "/character/documents",
  files: "/apps/files",
  plugins: "/apps/plugins",
  skills: "/apps/skills",
  "fine-tuning": "/apps/fine-tuning",
  trajectories: "/apps/trajectories",
  transcripts: "/apps/transcripts",
  relationships: "/apps/relationships",
  memories: "/apps/memories",
  rolodex: "/rolodex",
  voice: "/settings/voice",
  runtime: "/apps/runtime",
  database: "/apps/database",
  desktop: "/desktop",
  settings: "/settings",
  tutorial: "/tutorial",
  help: "/help",
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
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop-portrait", width: 1024, height: 1366 },
  { name: "mobile-landscape", width: 844, height: 390 },
] as const;

// ── Brand-color analysis (ported from cloud-frontend aesthetic-audit) ────────
interface ViewFinding {
  slug: string;
  viewport: string;
  path: string;
  consoleErrors: string[];
  blueColors: string[];
  hoverViolations: string[];
  borderRadiusViolations: string[];
  overlayPresent: boolean;
  viewType: "gui" | "tui";
  /** Readable text length in the view root; ~0 means the view never painted. */
  readableChars: number;
  /** Border/divider element count + viewport area for the "Her"-minimal gate (#9950). */
  borderDividerCount: number;
  viewportArea: number;
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: "good" | "needs-work" | "needs-eyeball" | "broken";
}

/**
 * Count rendered border/divider elements for the "Her"-minimal density gate
 * (#9950): an element with a visible border on any side (width ≥ 1px, style not
 * `none`/`hidden`), plus explicit `<hr>` and `role="separator"`. Returns the
 * count and the viewport area (px²) so the verdict policy can normalize.
 */
async function collectBorderDividerMetrics(
  page: Page,
): Promise<{ borderDividerCount: number; viewportArea: number }> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    let count = 0;
    for (const node of nodes) {
      const el = node as Element;
      if (el.tagName === "HR" || el.getAttribute("role") === "separator") {
        count += 1;
        continue;
      }
      const cs = getComputedStyle(el);
      const sides = [
        [cs.borderTopWidth, cs.borderTopStyle],
        [cs.borderRightWidth, cs.borderRightStyle],
        [cs.borderBottomWidth, cs.borderBottomStyle],
        [cs.borderLeftWidth, cs.borderLeftStyle],
      ] as const;
      const hasVisibleBorder = sides.some(
        ([width, style]) =>
          parseFloat(width) >= 1 && style !== "none" && style !== "hidden",
      );
      if (hasVisibleBorder) count += 1;
    }
    return {
      borderDividerCount: count,
      viewportArea: Math.max(1, window.innerWidth * window.innerHeight),
    };
  });
}

/** Scan the rendered DOM for any blue text/background/border color (banned). */
async function collectBlueColors(page: Page): Promise<string[]> {
  const colors = await page.evaluate(() => {
    const out = new Set<string>();
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      const cs = getComputedStyle(node as Element);
      out.add(cs.color);
      out.add(cs.backgroundColor);
      out.add(cs.borderTopColor);
    }
    return Array.from(out);
  });
  return colors.filter((c) => bucket(c) === "blue");
}

/** Tag primary buttons, read rest+hover backgrounds, flag brand violations. */
async function collectHoverViolations(page: Page): Promise<string[]> {
  const buttons = page.locator("button, a[role='button'], [data-audit-btn]");
  const count = Math.min(await buttons.count(), 24);
  const violations: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const rest = await btn
      .evaluate((el) => getComputedStyle(el).backgroundColor)
      .catch(() => "");
    if (bucket(rest) !== "orange") continue; // only orange-resting buttons matter
    await btn.hover({ timeout: 1000 }).catch(() => {});
    const hover = await btn
      .evaluate((el) => getComputedStyle(el).backgroundColor)
      .catch(() => "");
    const dest = bucket(hover);
    if (dest === "black" || dest === "white" || dest === "transparent") {
      const label = (await btn.innerText().catch(() => "")).slice(0, 24);
      violations.push(`"${label}" orange→${dest} (${rest} -> ${hover})`);
    }
  }
  return violations;
}

/**
 * Scan the rendered DOM for border-radius values that are NOT on the token
 * radius scale (presets.ts: radiusSm/Md/Lg/Xl/2xl/3xl → 6/8/12/16/20/24px at a
 * 16px root, plus the base `radius` 8px). Allowed alongside the token scale:
 * `0px` (square) and full-round shapes (`9999px`, `50%`, `100%`, circle pills).
 * Everything else (e.g. ad-hoc `4px`/`10px`) is an off-scale value that should
 * round to a token. Returns a deduped list of offending computed values so the
 * report can surface them; ±1px tolerance absorbs sub-pixel rounding.
 */
async function collectBorderRadiusViolations(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => {
    // Allowed px values from the token rem scale (16px root):
    //   0.375rem=6, 0.5rem=8, 0.75rem=12, 1rem=16, 1.25rem=20, 1.5rem=24.
    const allowedPx = [0, 6, 8, 12, 16, 20, 24];
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
    `- **floating chat overlay present:** ${finding.overlayPresent ? "yes" : "NO"}`,
    `- **readable content chars:** ${finding.readableChars}`,
    `- **minimalism — border/divider density:** ${(() => {
      const d = minimalismDensity(finding);
      return d === null
        ? "n/a"
        : `${d.toFixed(1)}/Mpx² (${finding.borderDividerCount} dividers; ceiling ${MINIMALISM_DENSITY_CEILING})${d > MINIMALISM_DENSITY_CEILING ? " ⚠ over budget" : ""}`;
    })()}`,
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
        const overlaySelector =
          "[data-continuous-chat-overlay], [data-testid='continuous-chat-overlay']";
        const readPaint = async (): Promise<{
          readableChars: number;
          overlayPresent: boolean;
          loadingViewVisible: boolean;
        }> => {
          const paint = await page
            .evaluate((selector) => {
              const isVisible = (element: HTMLElement): boolean => {
                const style = getComputedStyle(element);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  style.contentVisibility === "hidden"
                ) {
                  return false;
                }
                return element.getClientRects().length > 0;
              };
              const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                {
                  acceptNode(node) {
                    const value = node.textContent?.trim();
                    if (!value) return NodeFilter.FILTER_REJECT;
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    if (parent.closest(selector)) {
                      return NodeFilter.FILTER_REJECT;
                    }
                    return isVisible(parent)
                      ? NodeFilter.FILTER_ACCEPT
                      : NodeFilter.FILTER_REJECT;
                  },
                },
              );
              const chunks: string[] = [];
              while (walker.nextNode()) {
                chunks.push(walker.currentNode.textContent ?? "");
              }
              const text = chunks.join(" ").trim().replace(/\s+/g, " ");
              return {
                readableChars: text.length,
                loadingViewVisible: /\bLoading view\b/.test(text),
              };
            }, overlaySelector)
            .catch(() => ({
              readableChars: 0,
              loadingViewVisible: false,
            }));
          const overlayPresent = await page
            .locator(overlaySelector)
            .first()
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          return {
            readableChars: paint.loadingViewVisible ? 0 : paint.readableChars,
            overlayPresent,
            loadingViewVisible: paint.loadingViewVisible,
          };
        };
        let paint = await readPaint();
        for (
          let attempt = 0;
          attempt < 20 &&
          (paint.loadingViewVisible ||
            (paint.readableChars < 10 && !paint.overlayPresent));
          attempt += 1
        ) {
          await page.waitForTimeout(1000);
          paint = await readPaint();
        }
        const { readableChars, overlayPresent } = paint;

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
        const hoverViolations = await collectHoverViolations(page).catch(
          () => [],
        );
        const borderRadiusViolations = await collectBorderRadiusViolations(
          page,
        ).catch(() => []);
        const { borderDividerCount, viewportArea } =
          await collectBorderDividerMetrics(page).catch(() => ({
            borderDividerCount: 0,
            viewportArea: 1,
          }));

        const base = {
          slug: view.slug,
          viewport: vp.name,
          path: view.path,
          viewType: view.viewType,
          consoleErrors,
          blueColors,
          hoverViolations,
          borderRadiusViolations,
          overlayPresent,
          readableChars,
          borderDividerCount,
          viewportArea,
          quality,
          qualityIssues,
        };
        const finding: ViewFinding = {
          ...base,
          verdict: computeVerdict(base),
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
          `<td>${f.hoverViolations.length}</td><td>${f.overlayPresent ? "✓" : "✗"}</td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>app aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>view</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>radius</th><th>hover</th><th>overlay</th></tr>` +
        `${rows}</table>`,
      "utf8",
    );

    // Gate (#9304). Always log the verdict tally; in strict mode, fail the run
    // on any `broken` view not covered by the debt allowlist.
    const broken = findings.filter((f) => f.verdict === "broken");
    const needsWork = findings.filter((f) => f.verdict === "needs-work");
    const undebtedBroken = broken.filter(
      (f) => AESTHETIC_VERDICT_DEBT[`${f.slug}-${f.viewport}`] !== "broken",
    );
    console.log(
      `[aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length} ` +
        `(strict=${AUDIT_STRICT}, undebted-broken=${undebtedBroken.length})`,
    );
    if (AUDIT_STRICT && undebtedBroken.length > 0) {
      const detail = undebtedBroken
        .map(
          (f) =>
            `  ${f.slug} @ ${f.viewport}: ${
              [...f.consoleErrors, ...f.qualityIssues].join("; ") ||
              `readableChars=${f.readableChars}`
            }`,
        )
        .join("\n");
      throw new Error(
        `[aesthetic-audit] STRICT gate failed: ${undebtedBroken.length} ` +
          `non-exempt 'broken' view(s) not in AESTHETIC_VERDICT_DEBT:\n${detail}\n` +
          `Fix the view or, if genuinely accepted debt, add the slug-viewport key ` +
          `to AESTHETIC_VERDICT_DEBT (and shrink it over time).`,
      );
    }
  });
});
