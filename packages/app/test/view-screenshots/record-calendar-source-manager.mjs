/**
 * Records calendar source management through the isolated production view.
 *
 * The walkthrough proves progressive disclosure, a non-optimistic exclusion
 * write, and distinct discovery error/empty states while preserving browser
 * diagnostics beside the MP4.
 */

import { spawnSync } from "node:child_process";
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

if (!chromium) {
  throw new Error("could not resolve playwright chromium");
}

const outputDir = path.join(
  here,
  "output",
  "calendar-source-manager-walkthrough",
);

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  await build({
    configFile: path.join(here, "vite.config.mjs"),
    logLevel: "warn",
  });
  const previewServer = await preview({
    configFile: path.join(here, "vite.config.mjs"),
    preview: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "warn",
  });
  const url = previewServer.resolvedUrls?.local?.[0];
  if (!url) throw new Error("preview server produced no local URL");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: outputDir,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const transitions = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    requestFailures.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? "unknown request failure",
    });
  });

  const openState = async (state) => {
    const target = `${url.replace(/\/$/, "")}/index.html?view=calendar&state=${state}&compact=0`;
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
    if (renderError) throw new Error(`${state} render failed: ${renderError}`);
    return { state, target, renderError };
  };

  const capture = async (name, transition) => {
    const framePath = path.join(outputDir, `${name}.png`);
    await page.screenshot({ path: framePath, type: "png" });
    transitions.push({ ...transition, framePath });
    await page.waitForTimeout(1_100);
  };

  try {
    const mixed = await openState("sources-mixed");
    await capture("01-collapsed", mixed);
    await page.getByRole("button", { name: "Manage calendar sources" }).click();
    await page
      .getByRole("button", { name: "Close calendar source settings" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await capture("02-expanded-mixed", mixed);

    const workRow = page
      .locator('[data-testid^="calendar-source-row-"]')
      .filter({ hasText: "Work" })
      .first();
    await workRow
      .getByRole("switch", {
        name: /Include Work .* in the combined calendar/,
      })
      .click();
    await workRow.getByText("Excluding…").waitFor({ state: "visible" });
    await capture("03-write-pending", mixed);
    await workRow.getByText("Excluded").waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await capture("04-write-confirmed", mixed);

    const failed = await openState("sources-error");
    await page.getByRole("button", { name: "Manage calendar sources" }).click();
    await page
      .getByText("Calendar sources could not load.")
      .waitFor({ state: "visible" });
    await capture("05-discovery-error", failed);

    const empty = await openState("sources-empty");
    await page.getByRole("button", { name: "Manage calendar sources" }).click();
    await page
      .getByText("No calendar sources were found.")
      .waitFor({ state: "visible" });
    await capture("06-authoritative-empty", empty);
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => previewServer.httpServer.close(resolve));
  }

  if (!video) throw new Error("Playwright did not create a video");
  const generatedVideoPath = await video.path();
  const webmPath = path.join(
    outputDir,
    "calendar-source-manager-walkthrough.webm",
  );
  fs.copyFileSync(generatedVideoPath, webmPath);
  const videoPath = path.join(
    outputDir,
    "calendar-source-manager-walkthrough.mp4",
  );
  const conversion = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      webmPath,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      videoPath,
    ],
    { encoding: "utf8" },
  );
  if (conversion.error || conversion.status !== 0) {
    throw new Error(
      `ffmpeg conversion failed: ${conversion.error?.message ?? conversion.stderr}`,
    );
  }

  const diagnosticsPath = path.join(outputDir, "diagnostics.json");
  fs.writeFileSync(
    diagnosticsPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        transitions,
        webmPath,
        videoPath,
        consoleErrors,
        pageErrors,
        requestFailures,
      },
      null,
      2,
    )}\n`,
  );
  if (
    consoleErrors.length > 0 ||
    pageErrors.length > 0 ||
    requestFailures.length > 0
  ) {
    throw new Error(`walkthrough diagnostics failed: ${diagnosticsPath}`);
  }

  console.log(`[calendar-source-manager] video: ${videoPath}`);
  console.log(`[calendar-source-manager] diagnostics: ${diagnosticsPath}`);
}

// error-policy:J1 The CLI boundary turns capture failure into a visible non-zero exit.
main().catch((error) => {
  console.error("[calendar-source-manager] FATAL", error);
  process.exit(1);
});
