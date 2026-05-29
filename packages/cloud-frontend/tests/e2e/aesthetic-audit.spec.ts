/**
 * Cloud aesthetic + functional audit.
 *
 * For every concrete router path:
 *   - capture a full-page screenshot at desktop + mobile
 *   - capture a `<slug>--hover.png` after hovering the first primary button
 *   - measure logo size, nav padding, primary-button rest/hover/focus colors
 *   - flag any visible element whose computed border-radius is neither
 *     `--radius-xs` (3px) nor `9999px` (pill)
 *   - flag any hover transition that violates the palette rule:
 *     orange<->black or any blue (project rule: brand orange is accent only;
 *     blue is banned from this palette).
 *   - collect console errors and failed network requests
 *   - auto-stub `aesthetic-audit-output/manual-review/<slug>.md`
 *
 * Outputs `aesthetic-audit-output/{desktop,mobile}/<slug>.png` plus
 * `contact-sheet.html` and `report.json` summarising findings.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test } from "@playwright/test";
import sharp from "sharp";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Aesthetic audit targets local dev only; skipped in live-prod mode.",
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Write outside test-results/ so Playwright's per-run cleanup doesn't wipe
// the contact sheet between runs.
const OUT_ROOT = path.resolve(HERE, "../../aesthetic-audit-output");
const MANUAL_REVIEW_DIR = path.join(OUT_ROOT, "manual-review");

/**
 * Fixture id passed for parameterized routes. Real fixtures aren't worth
 * fabricating for a visual audit — capturing the empty/not-found state
 * is itself the deliverable.
 */
const FIXTURE_ID = "e2e-fixture";

interface RouteSpec {
  path: string;
  slug: string;
  auth?: boolean;
}

const ROUTES: RouteSpec[] = [
  // Public / unauthenticated
  { path: "/", slug: "landing" },
  { path: "/os", slug: "os" },
  { path: "/login", slug: "login" },
  { path: "/privacy-policy", slug: "privacy-policy" },
  { path: "/terms-of-service", slug: "terms-of-service" },
  { path: "/bsc", slug: "bsc" },
  { path: "/blog", slug: "blog" },
  { path: "/sandbox-proxy", slug: "sandbox-proxy" },
  { path: `/chat/${FIXTURE_ID}`, slug: "public-chat" },

  // Auth callbacks / shells
  { path: "/auth/success", slug: "auth-success" },
  { path: "/auth/cli-login", slug: "auth-cli-login" },
  { path: "/auth/error", slug: "auth-error" },
  { path: "/auth/callback/email", slug: "auth-callback-email" },
  { path: "/app-auth/authorize", slug: "app-auth-authorize" },
  { path: "/invite/accept", slug: "invite-accept" },

  // Payment + approval surfaces (parameterized — fixture renders error/empty)
  {
    path: `/payment/app-charge/${FIXTURE_ID}/${FIXTURE_ID}`,
    slug: "payment-app-charge",
  },
  { path: `/payment/${FIXTURE_ID}`, slug: "payment-request" },
  { path: "/payment/success", slug: "payment-success" },
  {
    path: `/sensitive-requests/${FIXTURE_ID}`,
    slug: "sensitive-request",
  },
  { path: `/approve/${FIXTURE_ID}`, slug: "approve" },
  { path: `/ballot/${FIXTURE_ID}`, slug: "ballot" },

  // Docs
  { path: "/docs/", slug: "docs-index" },

  // Dashboard top-level
  { path: "/dashboard", slug: "dashboard-home", auth: true },
  { path: "/dashboard/account", slug: "dashboard-account", auth: true },
  { path: "/dashboard/settings", slug: "dashboard-settings", auth: true },
  { path: "/dashboard/security", slug: "dashboard-security", auth: true },
  {
    path: "/dashboard/security/permissions",
    slug: "dashboard-security-permissions",
    auth: true,
  },
  { path: "/dashboard/billing", slug: "dashboard-billing", auth: true },
  {
    path: "/dashboard/billing/success",
    slug: "dashboard-billing-success",
    auth: true,
  },
  { path: "/dashboard/api-keys", slug: "dashboard-api-keys", auth: true },
  {
    path: "/dashboard/api-explorer",
    slug: "dashboard-api-explorer",
    auth: true,
  },
  { path: "/dashboard/agents", slug: "dashboard-agents", auth: true },
  {
    path: `/dashboard/agents/${FIXTURE_ID}`,
    slug: "dashboard-agent-detail",
    auth: true,
  },
  {
    path: `/dashboard/agents/${FIXTURE_ID}/chat`,
    slug: "dashboard-agent-chat",
    auth: true,
  },
  { path: "/dashboard/my-agents", slug: "dashboard-my-agents", auth: true },
  { path: "/dashboard/apps", slug: "dashboard-apps", auth: true },
  { path: "/dashboard/apps/create", slug: "dashboard-apps-create", auth: true },
  {
    path: `/dashboard/apps/${FIXTURE_ID}`,
    slug: "dashboard-app-detail",
    auth: true,
  },
  { path: "/dashboard/containers", slug: "dashboard-containers", auth: true },
  {
    path: `/dashboard/containers/${FIXTURE_ID}`,
    slug: "dashboard-container-detail",
    auth: true,
  },
  {
    path: `/dashboard/containers/agents/${FIXTURE_ID}`,
    slug: "dashboard-container-agent",
    auth: true,
  },
  { path: "/dashboard/mcps", slug: "dashboard-mcps", auth: true },
  { path: "/dashboard/documents", slug: "dashboard-documents", auth: true },
  { path: "/dashboard/analytics", slug: "dashboard-analytics", auth: true },
  { path: "/dashboard/earnings", slug: "dashboard-earnings", auth: true },
  { path: "/dashboard/affiliates", slug: "dashboard-affiliates", auth: true },
  {
    path: `/dashboard/invoices/${FIXTURE_ID}`,
    slug: "dashboard-invoice",
    auth: true,
  },
  { path: "/dashboard/chat", slug: "dashboard-chat", auth: true },
  { path: "/dashboard/image", slug: "dashboard-image", auth: true },
  { path: "/dashboard/video", slug: "dashboard-video", auth: true },
  { path: "/dashboard/gallery", slug: "dashboard-gallery", auth: true },
  { path: "/dashboard/voices", slug: "dashboard-voices", auth: true },

  // Admin
  { path: "/dashboard/admin", slug: "dashboard-admin", auth: true },
  {
    path: "/dashboard/admin/infrastructure",
    slug: "dashboard-admin-infra",
    auth: true,
  },
  {
    path: "/dashboard/admin/metrics",
    slug: "dashboard-admin-metrics",
    auth: true,
  },
  {
    path: "/dashboard/admin/redemptions",
    slug: "dashboard-admin-redemptions",
    auth: true,
  },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

interface RadiusViolation {
  selector: string;
  borderRadius: string;
  tag: string;
  classes: string;
}

interface ButtonColors {
  text: string;
  background: string;
  borderColor: string;
  boxShadow: string;
}

interface ButtonHover {
  text: string;
  rest: ButtonColors;
  hover: ButtonColors;
  focus: ButtonColors;
  paletteViolations: string[];
}

/**
 * Structured finding for the orange->black (or orange->white) hover
 * anti-pattern: a primary button rests on brand orange and its hover
 * destination collapses to black or white. Recorded — not thrown — so the
 * report/contact-sheet surfaces it without aborting the whole suite.
 */
interface HoverViolation {
  text: string;
  restBackground: string;
  hoverBackground: string;
  kind: "orange->black" | "orange->white";
}

interface PageReport {
  route: string;
  slug: string;
  viewport: string;
  screenshot: string;
  hoverScreenshot: string | null;
  consoleErrors: string[];
  failedRequests: { url: string; status: number }[];
  logo: { width: number; height: number; src: string } | null;
  navPaddingLeft: string | null;
  navPaddingRight: string | null;
  radiusViolations: RadiusViolation[];
  buttonHovers: ButtonHover[];
  paletteViolations: string[];
  hoverViolations: HoverViolation[];
  screenshotIssues: string[];
  loadOk: boolean;
  loadError?: string;
}

interface ScreenshotQuality {
  width: number;
  height: number;
  sampledPixels: number;
  colorBuckets: number;
  dominantRatio: number;
}

const FRAGMENT_DIR = path.join(OUT_ROOT, "_fragments");

test.beforeAll(() => {
  fs.mkdirSync(FRAGMENT_DIR, { recursive: true });
  for (const v of VIEWPORTS) {
    fs.mkdirSync(path.join(OUT_ROOT, v.name), { recursive: true });
  }
  fs.mkdirSync(MANUAL_REVIEW_DIR, { recursive: true });
  // Pre-seed manual-review stubs for every route. Existing files are never
  // overwritten — the human-authored review notes are the source of truth.
  for (const route of ROUTES) {
    const file = path.join(MANUAL_REVIEW_DIR, `${route.slug}.md`);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, renderManualReviewStub(route));
  }
});

function renderManualReviewStub(route: RouteSpec): string {
  return `# Manual review — ${route.slug}

Route: \`${route.path}\`${route.auth ? "  (auth-required)" : ""}

Screenshots:
- desktop: \`../desktop/${route.slug}.png\`
- desktop hover: \`../desktop/${route.slug}--hover.png\`
- mobile: \`../mobile/${route.slug}.png\`

## Checklist

- [ ] Header / nav present and aligned
- [ ] Logo size + nav padding match other pages
- [ ] No blue colors anywhere (banned from palette)
- [ ] Hover states do not transition orange<->black on the same element
- [ ] Focus ring is visible on every interactive element (tab through)
- [ ] Empty state renders cleanly (no broken layout)
- [ ] Loading state renders cleanly (no layout jump on data arrival)
- [ ] Mobile layout: no horizontal scroll, no overflow, tap targets >= 44px
- [ ] Text contrast meets WCAG AA against background
- [ ] Border radius is 3px (xs) or pill — no other rounding values
- [ ] No console errors in DevTools at rest
- [ ] No 5xx network requests

## Visual issues

_List anything that looks wrong._

## Color / hover violations

_Cite the element + the rest/hover colors._

## Layout breaks

_Cite the viewport + the element._

## Interaction targets to add to e2e

_Buttons/links that need automated coverage._

## Verdict

\`good\` | \`needs-work\` | \`broken\`

_Pick one. Until verdict is \`good\`, redo the audit loop after each fix._
`;
}

function persistReport(report: PageReport) {
  fs.mkdirSync(FRAGMENT_DIR, { recursive: true });
  const file = path.join(
    FRAGMENT_DIR,
    `${report.viewport}-${report.slug}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
}

test.afterAll(() => {
  fs.mkdirSync(FRAGMENT_DIR, { recursive: true });
  const all: PageReport[] = [];
  for (const f of fs.readdirSync(FRAGMENT_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      all.push(JSON.parse(fs.readFileSync(path.join(FRAGMENT_DIR, f), "utf8")));
    } catch {}
  }
  all.sort((a, b) => (a.viewport + a.slug).localeCompare(b.viewport + b.slug));
  fs.writeFileSync(
    path.join(OUT_ROOT, "report.json"),
    JSON.stringify(all, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_ROOT, "contact-sheet.html"),
    buildContactSheet(all),
  );
});

function buildContactSheet(reports: PageReport[]): string {
  const groups = new Map<string, PageReport[]>();
  for (const r of reports) {
    if (!groups.has(r.viewport)) groups.set(r.viewport, []);
    groups.get(r.viewport)?.push(r);
  }
  const sections: string[] = [];
  for (const [vp, list] of groups) {
    const cards = list
      .map((r) => {
        const issues: string[] = [];
        const consoleErrors = r.consoleErrors ?? [];
        const failedRequests = r.failedRequests ?? [];
        const radiusViolations = r.radiusViolations ?? [];
        const paletteViolations = r.paletteViolations ?? [];
        const hoverViolations = r.hoverViolations ?? [];
        const screenshotIssues = r.screenshotIssues ?? [];
        if (!r.loadOk) issues.push(`LOAD FAIL: ${r.loadError ?? "unknown"}`);
        if (consoleErrors.length)
          issues.push(`${consoleErrors.length} console errors`);
        if (failedRequests.length)
          issues.push(`${failedRequests.length} failed requests`);
        if (radiusViolations.length)
          issues.push(`${radiusViolations.length} radius violations`);
        if (paletteViolations.length)
          issues.push(`${paletteViolations.length} palette violations`);
        for (const hv of hoverViolations)
          issues.push(`hover ${hv.kind}: "${hv.text}"`);
        if (screenshotIssues.length)
          issues.push(`${screenshotIssues.length} screenshot issues`);
        const issueHtml = issues.length
          ? `<div class="issues">${issues.map((i) => `<div>! ${i}</div>`).join("")}</div>`
          : `<div class="ok">ok clean</div>`;
        const hoverImg = r.hoverScreenshot
          ? `<img loading="lazy" class="hover" src="${r.hoverScreenshot}" alt="${r.route} hover" />`
          : "";
        return `
          <figure>
            <img loading="lazy" src="${vp}/${r.slug}.png" alt="${r.route}" />
            ${hoverImg}
            <figcaption>
              <strong>${r.route}</strong>
              <div class="review"><a href="manual-review/${r.slug}.md">manual review</a></div>
              ${issueHtml}
              ${r.logo ? `<div class="logo">logo ${Math.round(r.logo.width)}x${Math.round(r.logo.height)}</div>` : ""}
              ${r.navPaddingLeft ? `<div class="nav">nav pad ${r.navPaddingLeft} / ${r.navPaddingRight}</div>` : ""}
            </figcaption>
          </figure>`;
      })
      .join("");
    sections.push(
      `<section><h2>${vp}</h2><div class="grid">${cards}</div></section>`,
    );
  }
  return `<!doctype html><meta charset="utf-8"><title>cloud aesthetic contact sheet</title>
<style>
  body { font: 13px system-ui, sans-serif; background: #111; color: #ddd; margin: 0; padding: 24px; }
  h1 { margin: 0 0 16px; }
  h2 { margin: 32px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; background: #1a1a1a; border: 1px solid #333; padding: 8px; }
  figure img { width: 100%; height: auto; display: block; background: #fff; }
  figure img.hover { margin-top: 6px; outline: 1px solid #ff8a00; }
  figcaption { padding-top: 8px; font-size: 12px; }
  .review a { color: #6cd97e; }
  .issues { color: #ffb454; margin-top: 4px; }
  .ok { color: #6cd97e; margin-top: 4px; }
  .logo, .nav { color: #888; }
</style>
<h1>cloud aesthetic contact sheet — ${new Date().toISOString()}</h1>
${sections.join("\n")}`;
}

/**
 * Palette rule:
 *  - brand orange (#ff8a00-ish) is an accent only; never a hover destination
 *    from neutral, and orange<->black hover transitions are banned.
 *  - blue (any hue 200-260 with meaningful saturation) is banned entirely.
 *
 * Inputs are CSS color strings already resolved by getComputedStyle, so
 * they should all be `rgb(...)` or `rgba(...)`. We parse them and bucket.
 */
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

type Bucket = "orange" | "black" | "blue" | "white" | "neutral" | "transparent";

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
  // Orange: red dominant, green moderate, blue low.
  if (r > 200 && g > 90 && g < 200 && b < 100) return "orange";
  // Blue: blue dominant by a clear margin.
  if (b > r + 20 && b > g + 10) return "blue";
  return "neutral";
}

function paletteCheckTransition(
  label: string,
  from: string,
  to: string,
): string | null {
  const a = bucket(from);
  const b = bucket(to);
  if (a === b) return null;
  if (a === "blue" || b === "blue") {
    return `${label}: blue is banned (${from} -> ${to})`;
  }
  if ((a === "orange" && b === "black") || (a === "black" && b === "orange")) {
    return `${label}: orange<->black transition (${from} -> ${to})`;
  }
  if (a === "neutral" && b === "orange") {
    return `${label}: neutral -> orange hover destination (${from} -> ${to})`;
  }
  return null;
}

function paletteCheckSingle(label: string, color: string): string | null {
  if (bucket(color) === "blue")
    return `${label}: blue color present (${color})`;
  return null;
}

/**
 * The orange->black anti-pattern: a button rests on brand orange and its
 * hover destination collapses to black (or white). Both directions of that
 * collapse are wrong — resting orange should darken to a deeper orange, not
 * jump to a non-orange neutral. Returns a structured finding or null.
 */
function detectHoverViolation(
  text: string,
  restBackground: string,
  hoverBackground: string,
): HoverViolation | null {
  if (bucket(restBackground) !== "orange") return null;
  const dest = bucket(hoverBackground);
  if (dest === "black") {
    return { text, restBackground, hoverBackground, kind: "orange->black" };
  }
  if (dest === "white") {
    return { text, restBackground, hoverBackground, kind: "orange->white" };
  }
  // An orange button whose hover background goes fully transparent collapses
  // onto whatever is behind it. On the black cloud theme that reads as
  // orange->black — the same anti-pattern, just spelled as `transparent`.
  if (dest === "transparent") {
    return { text, restBackground, hoverBackground, kind: "orange->black" };
  }
  return null;
}

async function analyzeScreenshot(buffer: Buffer): Promise<ScreenshotQuality> {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 96, height: 96, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = [
      Math.round(data[i] / 16),
      Math.round(data[i + 1] / 16),
      Math.round(data[i + 2] / 16),
      Math.round(data[i + 3] / 16),
    ].join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }

  const sampledPixels = info.width * info.height;
  const dominantCount = Math.max(0, ...buckets.values());
  return {
    width: info.width,
    height: info.height,
    sampledPixels,
    colorBuckets: buckets.size,
    dominantRatio: sampledPixels === 0 ? 1 : dominantCount / sampledPixels,
  };
}

function screenshotQualityIssues(
  label: string,
  quality: ScreenshotQuality,
): string[] {
  const issues: string[] = [];
  if (quality.sampledPixels === 0) {
    issues.push(`${label}: screenshot is empty`);
  }
  if (quality.colorBuckets <= 1) {
    issues.push(`${label}: screenshot is one color`);
  } else if (quality.colorBuckets <= 2 && quality.dominantRatio > 0.995) {
    issues.push(
      `${label}: screenshot is effectively one color (${quality.colorBuckets} color buckets, ${
        Math.round(quality.dominantRatio * 1000) / 10
      }% dominant)`,
    );
  }
  return issues;
}

async function captureAuditedScreenshot(
  page: Page,
  outputPath: string,
  label: string,
): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  let lastBuffer: Buffer | null = null;
  let lastIssues: string[] = [];

  while (Date.now() <= deadline) {
    const buffer = await page.screenshot({
      fullPage: true,
      timeout: 15_000,
    });
    lastBuffer = buffer;
    const quality = await analyzeScreenshot(buffer);
    lastIssues = screenshotQualityIssues(label, quality);
    if (lastIssues.length === 0) {
      fs.writeFileSync(outputPath, buffer);
      return [];
    }
    await page.waitForTimeout(500);
  }

  if (lastBuffer) {
    fs.writeFileSync(outputPath, lastBuffer);
  }
  return lastIssues;
}

function reportBlockingIssues(report: PageReport): string[] {
  const issues: string[] = [];
  if (!report.loadOk) {
    issues.push(
      `load failed for ${report.viewport}/${report.slug}: ${report.loadError ?? "unknown error"}`,
    );
  }
  for (const error of report.consoleErrors) {
    issues.push(
      `console error for ${report.viewport}/${report.slug}: ${error}`,
    );
  }
  for (const failed of report.failedRequests) {
    issues.push(
      `failed request for ${report.viewport}/${report.slug}: ${failed.status} ${failed.url}`,
    );
  }
  for (const violation of report.paletteViolations) {
    issues.push(
      `palette violation for ${report.viewport}/${report.slug}: ${violation}`,
    );
  }
  for (const violation of report.radiusViolations) {
    issues.push(
      `radius violation for ${report.viewport}/${report.slug}: ${violation.selector} ${violation.borderRadius} ${violation.classes}`,
    );
  }
  for (const issue of report.screenshotIssues) {
    issues.push(
      `screenshot issue for ${report.viewport}/${report.slug}: ${issue}`,
    );
  }
  return issues;
}

async function auditPage(
  page: Page,
  _route: string,
): Promise<{
  logo: PageReport["logo"];
  navPaddingLeft: string | null;
  navPaddingRight: string | null;
  radiusViolations: RadiusViolation[];
  buttonHovers: ButtonHover[];
  paletteViolations: string[];
  hoverViolations: HoverViolation[];
}> {
  const raw = await page.evaluate(() => {
    interface RawColors {
      text: string;
      background: string;
      borderColor: string;
      boxShadow: string;
    }
    interface RawHover {
      index: number;
      text: string;
      rest: RawColors;
      focus: RawColors;
    }
    interface RawRadius {
      selector: string;
      borderRadius: string;
      tag: string;
      classes: string;
    }
    interface RawAudit {
      logo: { width: number; height: number; src: string } | null;
      navPaddingLeft: string | null;
      navPaddingRight: string | null;
      radiusViolations: RawRadius[];
      buttonHovers: RawHover[];
    }

    function readColors(el: Element): RawColors {
      const cs = getComputedStyle(el);
      return {
        text: cs.color,
        background: cs.backgroundColor,
        borderColor: cs.borderTopColor,
        boxShadow: cs.boxShadow,
      };
    }

    const logoEl =
      (document.querySelector(
        'a[href="/"] img, a[href="/dashboard"] img, header img[alt*="liza" i], [aria-label="eliza cloud" i], [aria-label*="eliza" i][role="img"], img[alt*="eliza" i]',
      ) as HTMLElement | null) ??
      (document
        .querySelector('a[href="/"], a[href="/dashboard"]')
        ?.querySelector('[role="img"], img, svg') as HTMLElement | null);
    const logo = logoEl
      ? (() => {
          const rect = logoEl.getBoundingClientRect();
          const src =
            (logoEl as HTMLImageElement).src ??
            logoEl.getAttribute("src") ??
            logoEl.getAttribute("aria-label") ??
            "text-lockup";
          return { width: rect.width, height: rect.height, src };
        })()
      : null;

    const nav =
      (document.querySelector("header") as HTMLElement | null) ??
      (document.querySelector('[role="banner"]') as HTMLElement | null);
    const navCs = nav ? getComputedStyle(nav) : null;

    const violations: RawRadius[] = [];
    const elements = document.querySelectorAll<HTMLElement>(
      'button, [role="button"], input, select, textarea, [class*="card"], [class*="panel"], [class*="box"], [data-slot]',
    );
    const seen = new Set<string>();
    for (const el of elements) {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = cs.borderTopLeftRadius;
      const rNum = parseFloat(r);
      const minDim = Math.min(rect.width, rect.height);
      const isPill = rNum >= minDim / 2 - 1;
      if (rNum === 3 || rNum === 0 || isPill) continue;
      const key = `${el.tagName}.${el.className}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        selector: el.tagName.toLowerCase(),
        tag: el.tagName,
        borderRadius: r,
        classes:
          typeof el.className === "string" ? el.className.slice(0, 200) : "",
      });
      if (violations.length >= 25) break;
    }

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, a[role=button], [data-slot=button]",
      ),
    )
      .filter((b) => {
        const rect = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return (
          rect.width >= 8 &&
          rect.height >= 8 &&
          cs.display !== "none" &&
          cs.visibility !== "hidden"
        );
      })
      .slice(0, 8);

    const findFocusRule = (b: HTMLElement): RawColors | null => {
      const out: Partial<RawColors> = {};
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | null = null;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          if (!rules) continue;
          for (const rule of Array.from(rules)) {
            if (!(rule instanceof CSSStyleRule)) continue;
            if (
              !rule.selectorText.includes(":focus") &&
              !rule.selectorText.includes(":focus-visible")
            )
              continue;
            const base = rule.selectorText
              .replace(/:focus-visible/g, "")
              .replace(/:focus/g, "");
            try {
              if (!b.matches(base.trim())) continue;
            } catch {
              continue;
            }
            if (rule.style.boxShadow) out.boxShadow = rule.style.boxShadow;
            if (rule.style.outlineColor)
              out.borderColor = rule.style.outlineColor;
          }
        }
      } catch {}
      if (Object.keys(out).length === 0) return null;
      const rest = readColors(b);
      return {
        text: rest.text,
        background: rest.background,
        borderColor: out.borderColor ?? rest.borderColor,
        boxShadow: out.boxShadow ?? rest.boxShadow,
      };
    };

    // Tag each sampled button so the Playwright layer can re-locate it and
    // genuinely trigger :hover (computed-style scraping of CSS rules under-
    // reports — Tailwind variants, layered specificity, and JS-driven hover
    // are all invisible to it). Rest + focus colors are read here; the real
    // hover background is measured after a live `locator.hover()`.
    const buttonHovers: RawHover[] = buttons.map((b, index) => {
      b.setAttribute("data-audit-btn", String(index));
      const rest = readColors(b);
      const focus = findFocusRule(b) ?? rest;
      return {
        index,
        text: (b.textContent ?? "").trim().slice(0, 40),
        rest,
        focus,
      };
    });

    const result: RawAudit = {
      logo,
      navPaddingLeft: navCs?.paddingLeft ?? null,
      navPaddingRight: navCs?.paddingRight ?? null,
      radiusViolations: violations,
      buttonHovers,
    };
    return result;
  });

  // Genuinely hover each tagged button and re-read its computed background
  // AFTER the hover settles, so rest vs hover actually differ. CSS-rule
  // scraping (the previous approach) recorded rest==hover and missed every
  // real transition.
  const buttonHovers: ButtonHover[] = [];
  const hoverViolations: HoverViolation[] = [];

  for (const b of raw.buttonHovers) {
    const locator = page.locator(`[data-audit-btn="${b.index}"]`).first();
    let hover: ButtonColors = b.rest;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 });
      await locator.hover({ timeout: 1000 });
      // Let transitions/transforms settle before sampling.
      await page.waitForTimeout(200);
      const sampledHover = await page.evaluate((index) => {
        const el = document.querySelector<HTMLElement>(
          `[data-audit-btn="${index}"]`,
        );
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          text: cs.color,
          background: cs.backgroundColor,
          borderColor: cs.borderTopColor,
          boxShadow: cs.boxShadow,
        };
      }, b.index);
      if (sampledHover) hover = sampledHover;
    } catch {
      // Off-screen / detached / overlapped — fall back to rest colors. The
      // button simply contributes no hover finding rather than a false one.
    }
    // Move the pointer away so the next button starts from a clean rest
    // state (avoids a lingering :hover on an overlapping sibling).
    await page.mouse.move(0, 0).catch(() => {});

    const paletteViolations: string[] = [];
    const bgFlag = paletteCheckTransition(
      `button "${b.text}" bg`,
      b.rest.background,
      hover.background,
    );
    if (bgFlag) paletteViolations.push(bgFlag);
    const txtFlag = paletteCheckTransition(
      `button "${b.text}" text`,
      b.rest.text,
      hover.text,
    );
    if (txtFlag) paletteViolations.push(txtFlag);
    const restBlue = paletteCheckSingle(
      `button "${b.text}" rest bg`,
      b.rest.background,
    );
    if (restBlue) paletteViolations.push(restBlue);
    const focusBlue = paletteCheckSingle(
      `button "${b.text}" focus ring`,
      b.focus.borderColor,
    );
    if (focusBlue) paletteViolations.push(focusBlue);

    const hoverViolation = detectHoverViolation(
      b.text,
      b.rest.background,
      hover.background,
    );
    if (hoverViolation) hoverViolations.push(hoverViolation);

    buttonHovers.push({
      text: b.text,
      rest: b.rest,
      hover,
      focus: b.focus,
      paletteViolations,
    });
  }

  // Strip the audit tags so they don't leak into screenshots / DOM dumps.
  await page
    .evaluate(() => {
      for (const el of document.querySelectorAll("[data-audit-btn]")) {
        el.removeAttribute("data-audit-btn");
      }
    })
    .catch(() => {});

  const paletteViolations: string[] = [];
  for (const b of buttonHovers) paletteViolations.push(...b.paletteViolations);

  return {
    logo: raw.logo,
    navPaddingLeft: raw.navPaddingLeft,
    navPaddingRight: raw.navPaddingRight,
    radiusViolations: raw.radiusViolations,
    buttonHovers,
    paletteViolations,
    hoverViolations,
  };
}

// Viewport is controlled by this spec, so run only via one project (pass
// --project=chromium-desktop when invoking) to avoid duplicate runs.
for (const viewport of VIEWPORTS) {
  test.describe(`aesthetic audit — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });
    test.setTimeout(120_000);

    for (const route of ROUTES) {
      test(`${route.slug} (${viewport.name})`, async ({ page, context }) => {
        // Only inject the test-auth cookie for routes that require it.
        // Public routes (landing, login, /bsc, etc.) need to be captured
        // anonymously — otherwise `/` redirects to /dashboard and the
        // landing screenshot is wrong.
        if (route.auth) {
          await context.addCookies([
            {
              name: "eliza-test-auth",
              value: "1",
              domain: "127.0.0.1",
              path: "/",
              httpOnly: false,
              secure: false,
              sameSite: "Lax",
            },
          ]);
          // Inject a synthetic JWT into localStorage so the api-fetch
          // bridge sees a token and attaches the Bearer header. The
          // route mocks below catch every request so the token never
          // hits a real server; it just needs to exist for the auth
          // wrapper to proceed past its "no token → fetch fails" branch.
          const header = Buffer.from(
            JSON.stringify({ alg: "HS256", typ: "JWT" }),
            "utf8",
          )
            .toString("base64")
            .replace(/=+$/, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
          const payload = Buffer.from(
            JSON.stringify({
              sub: "22222222-2222-4222-8222-222222222222",
              userId: "22222222-2222-4222-8222-222222222222",
              address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
              email: "audit@example.com",
              exp: Math.floor(Date.now() / 1000) + 3600,
              iat: Math.floor(Date.now() / 1000),
            }),
            "utf8",
          )
            .toString("base64")
            .replace(/=+$/, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
          const token = `${header}.${payload}.audit-fake-signature`;
          await context.addInitScript((t: string) => {
            try {
              window.localStorage.setItem("steward_session_token", t);
            } catch {}
          }, token);
        } else {
          await context.clearCookies();
        }

        // Stub out API endpoints so the audit captures deterministic page
        // content instead of backend/proxy failures. Public parameterized
        // routes also depend on these fixtures, even when no auth cookie is
        // injected.
        await context.route(
          (url) => url.pathname.startsWith("/api/"),
          (r) => {
            const url = r.request().url();
            const empty = (json: unknown) =>
              r.fulfill({
                json,
                headers: { "content-type": "application/json" },
              });

            // Auth + session
            if (/\/sessions\/current/.test(url))
              return empty({
                id: "test-session",
                userId: "22222222-2222-4222-8222-222222222222",
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              });
            if (/\/auth\/logout/.test(url)) return empty({ ok: true });
            if (/\/me\/mfa/.test(url))
              return empty({ enrolled: false, methods: [] });
            if (/\/me\/plugin-grants/.test(url)) return empty({ grants: [] });

            // List endpoints
            if (/\/api-keys\/explorer/.test(url))
              return empty({
                apiKey: {
                  id: "audit-explorer-key",
                  name: "Audit Explorer Key",
                  description: "Synthetic key for the aesthetic audit",
                  key_prefix: "elizaaudit",
                  key: "elizaaudit_test_key",
                  created_at: new Date(0).toISOString(),
                  is_active: true,
                  usage_count: 0,
                  last_used_at: null,
                },
                isNew: false,
              });
            if (/\/api-keys($|\?)/.test(url))
              return empty({ keys: [], total: 0 });
            if (/\/containers(\/auth)?($|\?|\/[^/]+$)/.test(url))
              return empty({ containers: [] });
            if (/\/eliza\/agents($|\?)/.test(url))
              return empty({ success: true, data: [] });
            if (/\/eliza\/agents\/[^/?]+/.test(url))
              return empty({
                success: true,
                data: {
                  id: "e2e-fixture",
                  agentName: "E2E Test Agent",
                  status: "running",
                  databaseStatus: "connected",
                  lastBackupAt: null,
                  lastHeartbeatAt: new Date().toISOString(),
                  errorMessage: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  token_address: null,
                  token_chain: null,
                  token_name: null,
                  token_ticker: null,
                  bridgeUrl: null,
                  errorCount: 0,
                  walletAddress: null,
                  walletProvider: null,
                  walletStatus: "none",
                  adminDetails: null,
                },
              });
            if (/\/my-agents\/characters/.test(url))
              return empty({ success: true, data: { characters: [] } });
            if (/\/my-agents\/saved/.test(url))
              return empty({ success: true, data: { agents: [] } });
            if (/\/my-agents\/claim-affiliate-characters/.test(url))
              return empty({ success: true, claimed: [] });
            if (/\/agents(\/[^/]+)?($|\?)/.test(url)) return empty([]);
            if (/\/apps(\/[^/]+)?($|\?)/.test(url)) return empty({ apps: [] });
            if (/\/mcps($|\?)/.test(url)) return empty({ mcps: [] });
            if (/\/documents\/query/.test(url))
              return empty({ documents: [], total: 0 });
            if (/\/documents($|\?)/.test(url))
              return empty({ documents: [], total: 0 });
            if (/\/invoices\/list/.test(url))
              return empty({ invoices: [], total: 0 });
            if (/\/invoices/.test(url)) return empty({ invoices: [] });
            if (/\/redemptions\/balance/.test(url))
              return empty({
                balance: {
                  totalEarned: 0,
                  availableBalance: 0,
                  pendingBalance: 0,
                  totalRedeemed: 0,
                  totalPending: 0,
                  totalConvertedToCredits: 0,
                },
                bySource: [],
                recentEarnings: [],
                limits: {
                  minRedemptionUsd: 10,
                  maxSingleRedemptionUsd: 1000,
                  userDailyLimitUsd: 1000,
                  userHourlyLimitUsd: 250,
                },
                eligibility: {
                  canRedeem: false,
                  reason:
                    "Minimum redemption is $10.00. You have $0.00 available.",
                  dailyLimitRemaining: 1000,
                },
              });
            if (/\/redemptions\/status/.test(url))
              return empty({
                enabled: true,
                operational: true,
                networks: {
                  ethereum: { available: "available" },
                  base: { available: "available" },
                  solana: { available: "available" },
                },
              });
            if (/\/redemptions/.test(url))
              return empty({ redemptions: [], total: 0 });
            if (/\/affiliates/.test(url))
              return empty({
                code: {
                  id: "aff_test",
                  code: "TEST123",
                  markup_percent: "20.00",
                  is_active: true,
                },
              });
            if (/\/referrals/.test(url))
              return empty({
                code: "REF123",
                total_referrals: 0,
                is_active: true,
              });
            if (/\/quotas\/usage/.test(url))
              return empty({
                quotas: {},
                usage: { tokens: 0, requests: 0 },
              });
            if (/\/credits\/transactions/.test(url))
              return empty({ transactions: [], total: 0 });

            // Billing surfaces
            if (/\/billing\/settings/.test(url))
              return empty({
                settings: {
                  autoTopUp: {
                    enabled: false,
                    amount: null,
                    threshold: null,
                    paymentMethodId: null,
                  },
                  payAsYouGo: {
                    enabled: false,
                  },
                  limits: {
                    minTopUpAmount: 5,
                    maxTopUpAmount: 500,
                    minThreshold: 1,
                    maxThreshold: 100,
                  },
                },
              });
            if (/\/credits\/balance/.test(url))
              return empty({ balance: 0, currency: "USD" });
            if (/\/billing/.test(url))
              return empty({
                paymentMethods: [],
                subscriptions: [],
                upcomingInvoice: null,
              });
            if (/\/crypto\/(direct-payments|payments|status)/.test(url))
              return empty({ payments: [], enabled: true });
            if (/\/stripe\/create-checkout-session/.test(url))
              return empty({ url: "https://example.com/checkout" });

            // Dashboard / profile
            if (/\/dashboard\b/.test(url))
              return empty({
                user: { name: "Test User" },
                agents: [],
              });
            if (/\/v1\/user($|\?)/.test(url)) {
              const now = new Date().toISOString();
              return empty({
                success: true,
                data: {
                  id: "22222222-2222-4222-8222-222222222222",
                  email: "audit@example.com",
                  email_verified: true,
                  wallet_address: "0xE2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2E2",
                  wallet_chain_type: "ethereum",
                  wallet_verified: true,
                  name: "Test User",
                  avatar: null,
                  organization_id: "33333333-3333-4333-8333-333333333333",
                  role: "owner",
                  steward_user_id: "steward-test-user",
                  telegram_id: null,
                  telegram_username: null,
                  telegram_first_name: null,
                  telegram_photo_url: null,
                  discord_id: null,
                  discord_username: null,
                  discord_global_name: null,
                  discord_avatar_url: null,
                  whatsapp_id: null,
                  whatsapp_name: null,
                  phone_number: null,
                  phone_verified: null,
                  is_anonymous: false,
                  anonymous_session_id: null,
                  expires_at: null,
                  nickname: "Test",
                  work_function: null,
                  preferences: null,
                  email_notifications: true,
                  response_notifications: true,
                  is_active: true,
                  created_at: now,
                  updated_at: now,
                  organization: {
                    id: "33333333-3333-4333-8333-333333333333",
                    name: "Test Org",
                    created_at: now,
                    updated_at: now,
                    is_active: true,
                  },
                },
              });
            }
            if (/\/me($|\?)|\/profile/.test(url))
              return empty({
                id: "test-user",
                name: "Test User",
                email: "test@example.com",
              });
            if (/\/stats\/account/.test(url))
              return empty({
                lifetimeSpend: 0,
                requests: 0,
                tokens: 0,
              });

            // Settings + connectors
            if (
              /\/(telegram|whatsapp|twilio|discord|google|microsoft|blooio)\b/.test(
                url,
              )
            )
              return empty({ connected: false, account: null });
            if (/\/organizations\/(members|invites)/.test(url))
              return empty({ members: [], invites: [], total: 0 });

            // Security / sessions
            if (/\/sessions($|\?)/.test(url))
              return empty({ sessions: [], total: 0 });
            if (/\/security|\/permissions/.test(url))
              return empty({
                sessions: [],
                twoFactor: { enrolled: false },
                permissions: [],
              });

            // Analytics
            if (/\/analytics\/breakdown/.test(url))
              return empty({
                success: true,
                data: {
                  filters: {
                    startDate: "2026-05-14",
                    endDate: "2026-05-21",
                    granularity: "day",
                    timeRange: "weekly",
                  },
                  overallStats: {
                    totalRequests: 0,
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                    totalCost: 0,
                    successRate: 0,
                  },
                  timeSeriesData: [],
                  costTrending: {
                    currentDailyBurn: 0,
                    previousDailyBurn: 0,
                    burnChangePercent: 0,
                    projectedMonthlyBurn: 0,
                    daysUntilBalanceZero: null,
                    monthlyBurnPercent: 0,
                    monthlyBurnPercentClamped: 0,
                    burnAlertThresholdExceeded: false,
                  },
                  providerBreakdown: [],
                  modelBreakdown: [],
                  trends: {
                    requestsChange: 0,
                    costChange: 0,
                    tokensChange: 0,
                    successRateChange: 0,
                    period: "week",
                  },
                  organization: { creditBalance: "0.00" },
                },
              });
            if (/\/analytics\/projections/.test(url))
              return empty({
                success: true,
                data: {
                  historicalData: [],
                  projections: [],
                  alerts: [],
                  creditBalance: 0,
                },
              });
            if (/\/analytics|\/usage/.test(url))
              return empty({
                success: true,
                data: {
                  filters: {
                    startDate: "2026-05-14",
                    endDate: "2026-05-21",
                    granularity: "day",
                    timeRange: "weekly",
                  },
                  overallStats: {
                    totalRequests: 0,
                    totalInputTokens: 0,
                    totalOutputTokens: 0,
                    totalCost: 0,
                    successRate: 0,
                  },
                  timeSeriesData: [],
                  costTrending: {
                    currentDailyBurn: 0,
                    previousDailyBurn: 0,
                    burnChangePercent: 0,
                    projectedMonthlyBurn: 0,
                    daysUntilBalanceZero: null,
                    monthlyBurnPercent: 0,
                    monthlyBurnPercentClamped: 0,
                    burnAlertThresholdExceeded: false,
                  },
                  providerBreakdown: [],
                  modelBreakdown: [],
                  trends: {
                    requestsChange: 0,
                    costChange: 0,
                    tokensChange: 0,
                    successRateChange: 0,
                    period: "week",
                  },
                  organization: { creditBalance: "0.00" },
                },
              });
            if (/\/earnings/.test(url))
              return empty({ available: 0, lifetime: 0, history: [] });
            if (/\/pricing\/summary/.test(url))
              return empty({
                tiers: [],
                currentTier: null,
              });

            // OpenAPI spec — provide a tiny sample so api-explorer can
            // render at least one endpoint card.
            if (/\/openapi/.test(url))
              return empty({
                openapi: "3.0.0",
                info: { title: "Eliza Cloud", version: "1" },
                servers: [{ url: "https://api.eliza.os" }],
                paths: {
                  "/v1/chat": {
                    post: {
                      summary: "Chat completion",
                      tags: ["AI Completions"],
                      responses: {
                        "200": { description: "Success" },
                      },
                    },
                  },
                },
              });

            // Admin (dev-open after the use-admin / Layout patch)
            if (/\/admin\/moderation/.test(url))
              return r.fulfill({
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "X-Is-Admin": "true",
                  "X-Admin-Role": "super_admin",
                },
                json: { isAdmin: true, role: "super_admin" },
              });
            if (/\/admin\/metrics/.test(url))
              return empty({
                dau: 0,
                wau: 0,
                mau: 0,
                newSignupsToday: 0,
                newSignups7d: 0,
                avgMessagesPerUser: 0,
                platformBreakdown: {},
                platformDistribution: [],
                oauthRate: {
                  total_users: 0,
                  connected_users: 0,
                  rate: 0,
                  ratePercent: 0,
                  byService: {},
                },
                dailyTrend: [],
                retentionCohorts: [],
                retentionRates: [],
              });
            if (/\/admin\//.test(url)) return empty({ items: [], metrics: {} });

            // Permissive default — empty array works for most list endpoints.
            return empty([]);
          },
        );

        const consoleErrors: string[] = [];
        const failedRequests: { url: string; status: number }[] = [];

        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          if (text.startsWith("Failed to load resource")) return;
          if (text.includes("[RenderTelemetry]")) return;
          if (text.includes("[MyAgents] Failed to fetch")) return;
          if (text.includes("[MyAgents] Failed to claim")) return;
          if (text.includes("[CreditsProvider] Failed to fetch")) return;
          consoleErrors.push(text.slice(0, 400));
        });
        page.on("pageerror", (err) =>
          consoleErrors.push(`pageerror: ${err.message}`),
        );
        page.on("response", (resp) => {
          const status = resp.status();
          if (
            status >= 400 &&
            status !== 401 &&
            status !== 403 &&
            status !== 404
          ) {
            failedRequests.push({ url: resp.url(), status });
          }
        });

        const report: PageReport = {
          route: route.path,
          slug: route.slug,
          viewport: viewport.name,
          screenshot: `${viewport.name}/${route.slug}.png`,
          hoverScreenshot: null,
          consoleErrors,
          failedRequests,
          logo: null,
          navPaddingLeft: null,
          navPaddingRight: null,
          radiusViolations: [],
          buttonHovers: [],
          paletteViolations: [],
          hoverViolations: [],
          screenshotIssues: [],
          loadOk: false,
        };

        try {
          await page.goto(route.path, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await page.evaluate(() => document.fonts.ready).catch(() => {});
          // Wait for data fetches to settle so loading skeletons don't get
          // captured. `networkidle` resolves when there have been no
          // in-flight requests for 500ms; cap so a streaming endpoint
          // doesn't hang the audit forever.
          await page
            .waitForLoadState("networkidle", { timeout: 12_000 })
            .catch(() => {});
          // Wait for any skeleton placeholders to disappear so we capture
          // the populated UI, not the loader. Bounded so dynamic pages
          // (websocket / SSE) that legitimately keep a "live" indicator
          // don't hang the audit.
          await page
            .waitForFunction(
              () =>
                !document.querySelector(
                  '[data-state="loading"], [aria-busy="true"], .animate-pulse',
                ),
              null,
              { timeout: 8_000 },
            )
            .catch(() => {});
          // Final settle — allows post-data layout shift to complete.
          await page.waitForTimeout(600);
          const audit = await auditPage(page, route.path);
          Object.assign(report, audit, { loadOk: true });
          report.screenshotIssues.push(
            ...(await captureAuditedScreenshot(
              page,
              path.join(OUT_ROOT, viewport.name, `${route.slug}.png`),
              `${route.slug} ${viewport.name} rest`,
            )),
          );

          // Hover screenshot: hover the first visible primary button.
          const primary = page
            .locator(
              'button:visible, a[role="button"]:visible, [data-slot="button"]:visible',
            )
            .first();
          if ((await primary.count()) > 0) {
            try {
              await primary.scrollIntoViewIfNeeded({ timeout: 1500 });
              await primary.hover({ timeout: 1500, force: true });
              await page.waitForTimeout(200);
              const hoverPath = path.join(
                OUT_ROOT,
                viewport.name,
                `${route.slug}--hover.png`,
              );
              report.screenshotIssues.push(
                ...(await captureAuditedScreenshot(
                  page,
                  hoverPath,
                  `${route.slug} ${viewport.name} hover`,
                )),
              );
              report.hoverScreenshot = `${viewport.name}/${route.slug}--hover.png`;
            } catch {
              // Hovering failed (off-screen, detached, etc.) — not a fatal
              // condition. The rest screenshot is still captured.
            }
          }
        } catch (err) {
          report.loadError = err instanceof Error ? err.message : String(err);
        }

        persistReport(report);
        const blockingIssues = reportBlockingIssues(report);
        if (blockingIssues.length > 0) {
          throw new Error(blockingIssues.join("\n"));
        }
      });
    }
  });
}
