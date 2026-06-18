/**
 * LifeOps view screenshot harness.
 *
 * Renders each of the 9 decomposed LifeOps view components directly in headless
 * chromium — one (view × state × viewport) per page load — with the per-state
 * mock fetchers injected through each view's existing seam (a `fetchers` /
 * `fetchStatus` prop, or the `useCalendarWeek` hook for CalendarView). It does
 * NOT boot the agent stack; `@elizaos/ui`, `@elizaos/ui/agent-surface`, and the
 * calendar data-hook/drawer are aliased to inert stubs (see vite.config.mjs).
 *
 * Pipeline: vite build (SPA, query-param routed) → vite preview static server →
 * playwright chromium navigates `index.html?view=&state=&compact=` per cell →
 * waits for `window.__VIEW_HARNESS_READY__` → screenshots to
 * output/<view>-<state>-<viewport>.png. Each PNG is checked for blank/one-color
 * via the same analyzer the ui-smoke suite uses. Writes contact-sheet.md +
 * report.json.
 *
 * Run:  node packages/app/test/view-screenshots/run.mjs
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const appRoot = path.resolve(here, "../..");

// Resolve toolchain deps from packages/app (bun-hoisted .bun store).
const reqFromApp = createRequire(path.join(appRoot, "package.json"));
const { build, preview } = await import(reqFromApp.resolve("vite"));
const playwright = await import(reqFromApp.resolve("playwright"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("could not resolve playwright chromium");
const sharp = (await import(reqFromApp.resolve("sharp"))).default;

const { VIEW_SPECS } = await import("./fixtures.ts");

const OUTPUT_DIR = path.join(here, "output");
const VIEWPORTS = [
  { id: "desktop", width: 1280, height: 900 },
  { id: "mobile", width: 390, height: 844 },
];
const MIN_BYTES = 3_000;

// ---------------------------------------------------------------------------
// Screenshot quality analyzer — mirrors test/ui-smoke/helpers/screenshot-quality.
// ---------------------------------------------------------------------------

async function analyze(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .resize({ width: 96, height: 96, fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
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

function qualityIssues(label, q) {
  const issues = [];
  if (q.sampledPixels === 0) issues.push(`${label}: empty`);
  if (q.colorBuckets <= 1) issues.push(`${label}: one color`);
  else if (q.colorBuckets <= 2 && q.dominantRatio > 0.995)
    issues.push(
      `${label}: effectively one color (${q.colorBuckets} buckets, ${Math.round(q.dominantRatio * 1000) / 10}% dominant)`,
    );
  return issues;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log("[view-harness] building (vite)…");
  await build({ configFile: path.join(here, "vite.config.mjs"), logLevel: "warn" });

  console.log("[view-harness] starting preview server…");
  const previewServer = await preview({
    configFile: path.join(here, "vite.config.mjs"),
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "warn",
  });
  const url = previewServer.resolvedUrls?.local?.[0];
  if (!url) throw new Error("preview server produced no local URL");
  const base = url.replace(/\/$/, "");
  console.log(`[view-harness] preview at ${base}`);

  const browser = await chromium.launch({ headless: true });

  const report = [];
  const failures = [];
  let captured = 0;

  try {
    for (const [viewId, spec] of Object.entries(VIEW_SPECS)) {
      for (const state of spec.states) {
        for (const vp of VIEWPORTS) {
          const label = `${viewId}-${state}-${vp.id}`;
          const pngPath = path.join(OUTPUT_DIR, `${label}.png`);
          const compact = viewId === "calendar" && vp.id === "mobile" ? "1" : "0";
          const target = `${base}/index.html?view=${viewId}&state=${state}&compact=${compact}`;

          const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 1,
          });
          const page = await ctx.newPage();
          const consoleErrors = [];
          page.on("console", (m) => {
            if (m.type() === "error") consoleErrors.push(m.text());
          });
          page.on("pageerror", (e) => consoleErrors.push(String(e)));

          let renderError = null;
          try {
            await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 });
            // Wait until the entry signals ready OR records a harness error.
            await page.waitForFunction(
              () =>
                window.__VIEW_HARNESS_READY__ === true ||
                typeof window.__VIEW_HARNESS_ERROR__ === "string",
              { timeout: 15_000 },
            );
            renderError = await page.evaluate(
              () => window.__VIEW_HARNESS_ERROR__ ?? null,
            );
            // Loading states never settle effects further; give layout a beat.
            await page.waitForTimeout(120);
          } catch (e) {
            renderError = e instanceof Error ? e.message : String(e);
          }

          const buffer = await page.screenshot({ path: pngPath, type: "png" });
          const quality = await analyze(buffer);
          const issues = qualityIssues(label, quality);
          if (buffer.length <= MIN_BYTES)
            issues.unshift(`${label}: ${buffer.length}B <= ${MIN_BYTES}B`);
          const dominantColorOk = issues.length === 0;

          const entry = {
            view: viewId,
            state,
            viewport: vp.id,
            pngPath,
            bytes: buffer.length,
            colorBuckets: quality.colorBuckets,
            dominantRatio: Math.round(quality.dominantRatio * 1000) / 1000,
            dominantColorOk,
            renderError,
            consoleErrors: consoleErrors.slice(0, 5),
          };
          report.push(entry);
          captured += 1;

          if (renderError || !dominantColorOk) {
            failures.push(entry);
            console.log(
              `  ✗ ${label}  ${renderError ? `[render error] ` : ""}${issues.join("; ") || ""}`,
            );
          } else {
            console.log(
              `  ✓ ${label}  (${buffer.length}B, ${quality.colorBuckets} colors)`,
            );
          }

          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => previewServer.httpServer.close(resolve));
  }

  writeContactSheet(report);
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "report.json"),
    JSON.stringify(report, null, 2),
  );

  console.log(
    `\n[view-harness] captured ${captured} screenshots; ${failures.length} flagged.`,
  );
  console.log(`[view-harness] output: ${OUTPUT_DIR}`);
  console.log(`[view-harness] contact sheet: ${path.join(OUTPUT_DIR, "contact-sheet.md")}`);
  if (failures.length > 0) {
    console.log("\n[view-harness] FLAGGED:");
    for (const f of failures) {
      console.log(
        `  - ${f.view}-${f.state}-${f.viewport}: ${f.renderError ? `renderError=${f.renderError.split("\n")[0]}` : `quality (buckets=${f.colorBuckets}, dominant=${f.dominantRatio})`}`,
      );
    }
    process.exitCode = 1;
  }
}

function writeContactSheet(report) {
  const byView = new Map();
  for (const e of report) {
    if (!byView.has(e.view)) byView.set(e.view, []);
    byView.get(e.view).push(e);
  }
  const lines = [
    "# LifeOps view screenshots — contact sheet",
    "",
    `Generated ${new Date().toISOString()} · ${report.length} screenshots across ${byView.size} views.`,
    "",
    "Each view is captured per state at desktop (1280×900) and mobile (390×844).",
    "A ✗ marks a render error or a blank/one-color screenshot that needs a look.",
    "",
  ];
  for (const [view, entries] of byView) {
    lines.push(`## ${view}`);
    lines.push("");
    const states = [...new Set(entries.map((e) => e.state))];
    for (const state of states) {
      lines.push(`### ${view} — ${state}`);
      lines.push("");
      for (const vp of ["desktop", "mobile"]) {
        const e = entries.find((x) => x.state === state && x.viewport === vp);
        if (!e) continue;
        const ok = e.renderError ? "✗ render error" : e.dominantColorOk ? "✓" : "✗ quality";
        lines.push(
          `- **${vp}** ${ok} — \`${path.relative(here, e.pngPath)}\` (${e.bytes}B, ${e.colorBuckets} colors)`,
        );
        lines.push(`  - ![${view}-${state}-${vp}](${path.relative(here, e.pngPath)})`);
      }
      lines.push("");
    }
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, "contact-sheet.md"), lines.join("\n"));
}

main().catch((e) => {
  console.error("[view-harness] FATAL", e);
  process.exit(1);
});
