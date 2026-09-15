#!/usr/bin/env node
/**
 * Captures the production Calendar month-grid at desktop and mobile widths.
 * The focused entry isolates this release certificate from unrelated fixture
 * imports while preserving the same production component and data seams.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const reqFromApp = createRequire(path.join(appRoot, "package.json"));
const { build, preview } = await import(reqFromApp.resolve("vite"));
const playwright = await import(reqFromApp.resolve("playwright"));
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("could not resolve playwright chromium");

const outputDir = path.join(here, "output", "calendar-responsive");
const cases = [
  ...["day", "week", "month"].flatMap((mode) => [
    {
      state: "populated",
      mode,
      viewport: "desktop",
      width: 1280,
      height: 900,
    },
    {
      state: "populated",
      mode,
      viewport: "mobile",
      width: 390,
      height: 844,
    },
  ]),
  {
    state: "empty",
    mode: "month",
    viewport: "desktop",
    width: 1280,
    height: 900,
  },
  {
    state: "empty",
    mode: "month",
    viewport: "mobile",
    width: 390,
    height: 844,
  },
];

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({
    configFile: path.join(here, "vite.config.mjs"),
    build: {
      rollupOptions: { input: path.join(here, "calendar-only.html") },
    },
    logLevel: "warn",
  });
  const server = await preview({
    configFile: path.join(here, "vite.config.mjs"),
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "warn",
  });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, "");
  if (!base) throw new Error("preview server produced no local URL");

  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const auditCase of cases) {
      const context = await browser.newContext({
        viewport: { width: auditCase.width, height: auditCase.height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const target = `${base}/calendar-only.html?state=${auditCase.state}&mode=${auditCase.mode}&compact=${auditCase.viewport === "mobile" ? "1" : "0"}`;
      await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForFunction(
        () =>
          window.__VIEW_HARNESS_READY__ === true ||
          typeof window.__VIEW_HARNESS_ERROR__ === "string",
        { timeout: 15_000 },
      );
      const renderError = await page.evaluate(
        () => window.__VIEW_HARNESS_ERROR__ ?? null,
      );
      const grid = page.getByTestId("lifeops-calendar-section");
      await grid.waitFor({ state: "visible", timeout: 5_000 });
      const box = await grid.boundingBox();
      if (!box || box.width > auditCase.width || box.width < 300) {
        throw new Error(
          `${auditCase.viewport}/${auditCase.state} month grid has invalid width ${box?.width ?? "missing"}`,
        );
      }
      const monthLayout =
        auditCase.mode === "month" && auditCase.viewport === "desktop"
          ? await page
              .getByTestId("calendar-month-grid")
              .locator(":scope > div")
              .evaluateAll((rows) =>
                rows.map((row) => ({
                  columns: getComputedStyle(row).gridTemplateColumns
                    .split(" ")
                    .filter(Boolean).length,
                  cells: row.children.length,
                })),
              )
          : null;
      const imagePath = path.join(
        outputDir,
        `${auditCase.viewport}-${auditCase.mode}-${auditCase.state}.png`,
      );
      await page.screenshot({ path: imagePath, fullPage: false });
      report.push({
        ...auditCase,
        target,
        imagePath,
        box,
        monthLayout,
        renderError,
        consoleErrors,
        pageErrors,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }

  const failures = report.filter(
    (entry) =>
      entry.renderError ||
      entry.consoleErrors.length > 0 ||
      entry.pageErrors.length > 0 ||
      (entry.monthLayout !== null &&
        (entry.monthLayout.length !== 2 ||
          entry.monthLayout[0]?.columns !== 7 ||
          entry.monthLayout[0]?.cells !== 7 ||
          entry.monthLayout[1]?.columns !== 7 ||
          entry.monthLayout[1]?.cells !== 42)),
  );
  const reportPath = path.join(outputDir, "report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) {
    throw new Error(`calendar visual diagnostics failed: ${reportPath}`);
  }
  console.log(`[calendar-responsive] report: ${reportPath}`);
}

// error-policy:J1 The capture CLI reports browser failures as a non-zero exit.
main().catch((error) => {
  console.error("[calendar-responsive] FATAL", error);
  process.exit(1);
});
