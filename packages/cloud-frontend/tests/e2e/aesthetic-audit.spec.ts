/**
 * Cloud aesthetic + functional audit.
 *
 * For every concrete router path:
 *   - capture a full-page screenshot at desktop + mobile
 *   - measure logo size, nav padding, primary-button hover color
 *   - flag any visible element whose computed border-radius is neither
 *     `--radius-xs` (3px) nor `9999px` (pill)
 *   - collect console errors and failed network requests
 *
 * Outputs `test-results/aesthetic-audit/<viewport>/<slug>.png` plus a
 * `contact-sheet.html` and `report.json` summarising findings across
 * every page.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Aesthetic audit targets local dev only; skipped in live-prod mode.",
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Write outside test-results/ so Playwright's per-run cleanup doesn't wipe
// the contact sheet between runs.
const OUT_ROOT = path.resolve(HERE, "../../aesthetic-audit-output");

const ROUTES: { path: string; slug: string; auth?: boolean }[] = [
  { path: "/", slug: "landing" },
  { path: "/login", slug: "login" },
  { path: "/privacy-policy", slug: "privacy-policy" },
  { path: "/terms-of-service", slug: "terms-of-service" },
  { path: "/bsc", slug: "bsc" },
  { path: "/sandbox-proxy", slug: "sandbox-proxy" },
  { path: "/auth/success", slug: "auth-success" },
  { path: "/auth/cli-login", slug: "auth-cli-login" },
  { path: "/auth/error", slug: "auth-error" },
  { path: "/dashboard", slug: "dashboard-home", auth: true },
  { path: "/dashboard/account", slug: "dashboard-account", auth: true },
  { path: "/dashboard/settings", slug: "dashboard-settings", auth: true },
  { path: "/dashboard/billing", slug: "dashboard-billing", auth: true },
  { path: "/dashboard/api-keys", slug: "dashboard-api-keys", auth: true },
  { path: "/dashboard/api-explorer", slug: "dashboard-api-explorer", auth: true },
  { path: "/dashboard/agents", slug: "dashboard-agents", auth: true },
  { path: "/dashboard/my-agents", slug: "dashboard-my-agents", auth: true },
  { path: "/dashboard/apps", slug: "dashboard-apps", auth: true },
  { path: "/dashboard/apps/create", slug: "dashboard-apps-create", auth: true },
  { path: "/dashboard/containers", slug: "dashboard-containers", auth: true },
  { path: "/dashboard/mcps", slug: "dashboard-mcps", auth: true },
  { path: "/dashboard/documents", slug: "dashboard-documents", auth: true },
  { path: "/dashboard/analytics", slug: "dashboard-analytics", auth: true },
  { path: "/dashboard/earnings", slug: "dashboard-earnings", auth: true },
  { path: "/dashboard/affiliates", slug: "dashboard-affiliates", auth: true },
  { path: "/dashboard/admin", slug: "dashboard-admin", auth: true },
  { path: "/dashboard/admin/infrastructure", slug: "dashboard-admin-infra", auth: true },
  { path: "/dashboard/admin/metrics", slug: "dashboard-admin-metrics", auth: true },
  { path: "/dashboard/admin/redemptions", slug: "dashboard-admin-redemptions", auth: true },
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

interface ButtonHover {
  text: string;
  rest: string;
  hover: string;
}

interface PageReport {
  route: string;
  slug: string;
  viewport: string;
  screenshot: string;
  consoleErrors: string[];
  failedRequests: { url: string; status: number }[];
  logo: { width: number; height: number; src: string } | null;
  navPaddingLeft: string | null;
  navPaddingRight: string | null;
  radiusViolations: RadiusViolation[];
  buttonHovers: ButtonHover[];
  loadOk: boolean;
  loadError?: string;
}

const FRAGMENT_DIR = path.join(OUT_ROOT, "_fragments");

test.beforeAll(() => {
  for (const v of VIEWPORTS) {
    fs.mkdirSync(path.join(OUT_ROOT, v.name), { recursive: true });
  }
  fs.mkdirSync(FRAGMENT_DIR, { recursive: true });
});

function persistReport(report: PageReport) {
  const file = path.join(FRAGMENT_DIR, `${report.viewport}-${report.slug}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
}

test.afterAll(() => {
  const all: PageReport[] = [];
  for (const f of fs.readdirSync(FRAGMENT_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      all.push(JSON.parse(fs.readFileSync(path.join(FRAGMENT_DIR, f), "utf8")));
    } catch {}
  }
  all.sort((a, b) => (a.viewport + a.slug).localeCompare(b.viewport + b.slug));
  fs.writeFileSync(path.join(OUT_ROOT, "report.json"), JSON.stringify(all, null, 2));
  fs.writeFileSync(path.join(OUT_ROOT, "contact-sheet.html"), buildContactSheet(all));
});

function buildContactSheet(reports: PageReport[]): string {
  const groups = new Map<string, PageReport[]>();
  for (const r of reports) {
    if (!groups.has(r.viewport)) groups.set(r.viewport, []);
    groups.get(r.viewport)!.push(r);
  }
  const sections: string[] = [];
  for (const [vp, list] of groups) {
    const cards = list
      .map((r) => {
        const issues: string[] = [];
        if (!r.loadOk) issues.push(`LOAD FAIL: ${r.loadError ?? "unknown"}`);
        if (r.consoleErrors.length) issues.push(`${r.consoleErrors.length} console errors`);
        if (r.failedRequests.length) issues.push(`${r.failedRequests.length} failed requests`);
        if (r.radiusViolations.length) issues.push(`${r.radiusViolations.length} radius violations`);
        const issueHtml = issues.length
          ? `<div class="issues">${issues.map((i) => `<div>⚠ ${i}</div>`).join("")}</div>`
          : `<div class="ok">✓ clean</div>`;
        return `
          <figure>
            <img loading="lazy" src="${vp}/${r.slug}.png" alt="${r.route}" />
            <figcaption>
              <strong>${r.route}</strong>
              ${issueHtml}
              ${r.logo ? `<div class="logo">logo ${Math.round(r.logo.width)}×${Math.round(r.logo.height)}</div>` : ""}
              ${r.navPaddingLeft ? `<div class="nav">nav pad ${r.navPaddingLeft} / ${r.navPaddingRight}</div>` : ""}
            </figcaption>
          </figure>`;
      })
      .join("");
    sections.push(`<section><h2>${vp}</h2><div class="grid">${cards}</div></section>`);
  }
  return `<!doctype html><meta charset="utf-8"><title>cloud aesthetic contact sheet</title>
<style>
  body { font: 13px system-ui, sans-serif; background: #111; color: #ddd; margin: 0; padding: 24px; }
  h1 { margin: 0 0 16px; }
  h2 { margin: 32px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; background: #1a1a1a; border: 1px solid #333; padding: 8px; }
  figure img { width: 100%; height: auto; display: block; background: #fff; }
  figcaption { padding-top: 8px; font-size: 12px; }
  .issues { color: #ffb454; margin-top: 4px; }
  .ok { color: #6cd97e; margin-top: 4px; }
  .logo, .nav { color: #888; }
</style>
<h1>cloud aesthetic contact sheet — ${new Date().toISOString()}</h1>
${sections.join("\n")}`;
}

async function auditPage(page: Page, route: string): Promise<{
  logo: PageReport["logo"];
  navPaddingLeft: string | null;
  navPaddingRight: string | null;
  radiusViolations: RadiusViolation[];
  buttonHovers: ButtonHover[];
}> {
  return page.evaluate(() => {
    const logoEl =
      (document.querySelector(
        'a[href="/"] img, a[href="/dashboard"] img, header img[alt*="liza" i], [aria-label="eliza cloud" i], [aria-label*="eliza" i][role="img"], img[alt*="eliza" i]',
      ) as HTMLElement | null) ??
      (document.querySelector('a[href="/"], a[href="/dashboard"]')?.querySelector(
        '[role="img"], img, svg',
      ) as HTMLElement | null);
    const logo = logoEl
      ? (() => {
          const rect = logoEl.getBoundingClientRect();
          const src =
            (logoEl as HTMLImageElement).src ??
            logoEl.getAttribute("src") ??
            (logoEl.getAttribute("aria-label") ?? "text-lockup");
          return { width: rect.width, height: rect.height, src };
        })()
      : null;

    const nav =
      (document.querySelector("header") as HTMLElement | null) ??
      (document.querySelector('[role="banner"]') as HTMLElement | null);
    const navCs = nav ? getComputedStyle(nav) : null;

    const violations: RadiusViolation[] = [];
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
      // Accept 3px (xs), 0px (no rounding intentionally), or pill (>= half min dimension)
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
        classes: typeof el.className === "string" ? el.className.slice(0, 200) : "",
      });
      if (violations.length >= 25) break;
    }

    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button, a[role=button], [data-slot=button]")).slice(0, 8);
    const buttonHovers: ButtonHover[] = buttons.map((b) => {
      const rest = getComputedStyle(b).backgroundColor;
      // Simulate :hover by adding a marker class + reading the matched
      // `:hover` style via getMatchedCSSRules isn't available; instead use
      // CSS.supports check + querying stylesheet for a `:hover` rule on
      // matching selectors. Fallback to rest if not derivable.
      let hover = rest;
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | null = null;
          try { rules = sheet.cssRules; } catch { continue; }
          if (!rules) continue;
          for (const rule of Array.from(rules)) {
            if (!(rule instanceof CSSStyleRule)) continue;
            if (!rule.selectorText.includes(":hover")) continue;
            const base = rule.selectorText.replace(/:hover/g, "");
            try {
              if (b.matches(base.trim()) && rule.style.backgroundColor) {
                hover = rule.style.backgroundColor;
              }
            } catch {}
          }
        }
      } catch {}
      return { text: (b.textContent ?? "").trim().slice(0, 40), rest, hover };
    });

    return {
      logo,
      navPaddingLeft: navCs?.paddingLeft ?? null,
      navPaddingRight: navCs?.paddingRight ?? null,
      radiusViolations: violations,
      buttonHovers,
    };
  });
}

// Viewport is controlled by this spec, so run only via one project (pass
// --project=chromium-desktop when invoking) to avoid duplicate runs.
for (const viewport of VIEWPORTS) {
  test.describe(`aesthetic audit — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ context }) => {
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
    });

    for (const route of ROUTES) {
      test(`${route.slug} (${viewport.name})`, async ({ page }) => {
        const consoleErrors: string[] = [];
        const failedRequests: { url: string; status: number }[] = [];

        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          // Browser-generated "Failed to load resource" errors duplicate
          // information already captured in failedRequests. RenderTelemetry
          // warnings are heuristic, not real failures.
          if (text.startsWith("Failed to load resource")) return;
          if (text.includes("[RenderTelemetry]")) return;
          // [MyAgents] / [CreditsProvider] errors triggered by 401s from
          // unauthenticated audit (test cookie isn't a real session). These
          // are downstream of the same root cause already counted via
          // failedRequests when they're real.
          if (text.includes("[MyAgents] Failed to fetch")) return;
          if (text.includes("[MyAgents] Failed to claim")) return;
          if (text.includes("[CreditsProvider] Failed to fetch")) return;
          consoleErrors.push(text.slice(0, 400));
        });
        page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
        page.on("response", (resp) => {
          const status = resp.status();
          if (status >= 400 && status !== 401 && status !== 403 && status !== 404) {
            failedRequests.push({ url: resp.url(), status });
          }
        });

        const report: PageReport = {
          route: route.path,
          slug: route.slug,
          viewport: viewport.name,
          screenshot: `${viewport.name}/${route.slug}.png`,
          consoleErrors,
          failedRequests,
          logo: null,
          navPaddingLeft: null,
          navPaddingRight: null,
          radiusViolations: [],
          buttonHovers: [],
          loadOk: false,
        };

        try {
          await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await page.evaluate(() => document.fonts.ready).catch(() => {});
          await page.waitForTimeout(600);
          const audit = await auditPage(page, route.path);
          Object.assign(report, audit, { loadOk: true });
          await page.screenshot({
            path: path.join(OUT_ROOT, viewport.name, `${route.slug}.png`),
            fullPage: true,
          });
        } catch (err) {
          report.loadError = err instanceof Error ? err.message : String(err);
        }

        persistReport(report);
      });
    }
  });
}
