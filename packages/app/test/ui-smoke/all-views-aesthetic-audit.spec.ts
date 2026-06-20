import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
const BUILTIN_TAB_PATHS: Record<string, string> = {
  chat: "/chat",
  phone: "/phone",
  messages: "/messages",
  contacts: "/contacts",
  camera: "/camera",
  tasks: "/apps/tasks",
  automations: "/automations",
  views: "/views",
  character: "/character",
  inventory: "/wallet",
  documents: "/character/documents",
  plugins: "/apps/plugins",
  skills: "/apps/skills",
  "fine-tuning": "/apps/fine-tuning",
  runtime: "/apps/runtime",
  database: "/apps/database",
  settings: "/settings",
  help: "/help",
  logs: "/apps/logs",
};

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

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

// ── Brand-color analysis (ported from cloud-frontend aesthetic-audit) ────────
type Bucket = "orange" | "black" | "blue" | "white" | "neutral" | "transparent";

function parseRgb(input: string): [number, number, number, number] | null {
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

function bucket(color: string): Bucket {
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
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: "good" | "needs-work" | "broken";
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

function renderManualReviewStub(finding: ViewFinding): string {
  const lines = [
    `# ${finding.slug} (${finding.viewport})`,
    "",
    `- **path:** \`${finding.path}\``,
    `- **verdict:** ${finding.verdict}`,
    `- **console errors:** ${finding.consoleErrors.length}`,
    `- **blue colors (banned):** ${finding.blueColors.length ? finding.blueColors.join(", ") : "none"}`,
    `- **orange↔black hover violations:** ${finding.hoverViolations.length ? finding.hoverViolations.join("; ") : "none"}`,
    `- **floating chat overlay present:** ${finding.overlayPresent ? "yes" : "NO"}`,
    `- **readable content chars:** ${finding.readableChars}`,
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
const OVERLAY_NATIVE_OR_CANVAS_SLUGS = new Set([
  "builtin-chat",
  "builtin-phone",
  "builtin-messages",
  "builtin-camera",
  "plugin-phone-gui",
  "plugin-messages-gui",
  "plugin-scape-gui",
  "plugin-2004scape-gui",
  "plugin-clawville-gui",
  "plugin-hyperscape-gui",
  "plugin-defense-of-the-agents-gui",
]);

function computeVerdict(
  finding: Omit<ViewFinding, "verdict">,
): ViewFinding["verdict"] {
  const exempt =
    finding.viewType === "tui" ||
    OVERLAY_NATIVE_OR_CANVAS_SLUGS.has(finding.slug);
  // A console error (a real crash signal) is broken for every view. Overlay-
  // native/canvas/terminal surfaces legitimately render little chrome text and
  // screenshot near-one-color (an overlay over a solid bg, an empty canvas), so
  // the readable-content + blank-screenshot floors are waived for them.
  if (
    finding.consoleErrors.length > 0 ||
    (!exempt &&
      (finding.qualityIssues.length > 0 || finding.readableChars < 10))
  ) {
    return "broken";
  }
  // TUI terminals are exempt from ALL color/light-surface rules (#8796 open
  // question): a terminal renders an ANSI/slate palette by design, so blue-gray
  // there is the terminal aesthetic, not a brand violation. They pass once they
  // render with no real console errors.
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
  return "good";
}

const findings: ViewFinding[] = [];

test.describe("all-views aesthetic audit (#8796)", () => {
  const outputDir =
    process.env.ELIZA_AUDIT_APP_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output");

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
            .first()
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          return { readableChars, overlayPresent };
        };
        let paint = await readPaint();
        for (
          let attempt = 0;
          attempt < 12 && paint.readableChars < 10 && !paint.overlayPresent;
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

        const base = {
          slug: view.slug,
          viewport: vp.name,
          path: view.path,
          viewType: view.viewType,
          consoleErrors,
          blueColors,
          hoverViolations,
          borderRadiusViolations: [],
          overlayPresent,
          readableChars,
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
          `<td>${f.hoverViolations.length}</td><td>${f.overlayPresent ? "✓" : "✗"}</td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>app aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>view</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>hover</th><th>overlay</th></tr>` +
        `${rows}</table>`,
      "utf8",
    );
  });
});
