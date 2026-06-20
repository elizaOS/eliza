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

function computeVerdict(
  finding: Omit<ViewFinding, "verdict">,
): ViewFinding["verdict"] {
  if (
    finding.consoleErrors.length > 0 ||
    finding.qualityIssues.length > 0 ||
    finding.readableChars < 10
  ) {
    return "broken";
  }
  // TUI views are intentionally dark terminals (#8796 open question): exempt
  // them from the light-surface blue/hover heuristics and the floating-overlay
  // requirement — they pass once they render with no console errors.
  if (finding.viewType === "tui") {
    return "good";
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
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        await seedAppStorage(page);
        await installDefaultAppRoutes(page);
        await openAppPath(page, view.path);

        // Best-effort readiness: most views render <main>, but chat/phone/etc.
        // render straight into #root with no <main>. Wait for whichever appears
        // (short, non-fatal) so the audit walks EVERY view — a view that never
        // paints readable content is recorded as a finding, not a hard failure.
        const viewRoot = page.locator("main, #root").first();
        await viewRoot
          .waitFor({ state: "visible", timeout: 15_000 })
          .catch(() => {});
        const readableChars = await viewRoot
          .evaluate(
            (root) =>
              (root as HTMLElement).innerText.trim().replace(/\s+/g, " ")
                .length,
          )
          .catch(() => 0);

        // Floating chat overlay must integrate over every view (#8796 item 3).
        const overlayPresent = await page
          .locator(
            "[data-continuous-chat-overlay], [data-testid='continuous-chat-overlay']",
          )
          .first()
          .count()
          .then((c) => c > 0)
          .catch(() => false);

        const restPath = path.join(shotDir, `${view.slug}.png`);
        const buffer = await page.screenshot({
          path: restPath,
          fullPage: false,
        });
        const quality = await analyzeScreenshot(buffer).catch(() => null);
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
