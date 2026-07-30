/**
 * Records the calendar source-health states through the same isolated visual
 * harness used for screenshot review, while preserving browser diagnostics.
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

const states = ["loading", "partial", "unavailable", "populated"];
const outputDir = path.join(here, "output", "calendar-walkthrough");

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
  if (!url) {
    throw new Error("preview server produced no local URL");
  }

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
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    requestFailures.push({
      method: request.method(),
      url: request.url(),
      errorText: request.failure()?.errorText ?? "unknown request failure",
    });
  });

  try {
    for (const [index, state] of states.entries()) {
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
      if (renderError) {
        throw new Error(`${state} render failed: ${renderError}`);
      }

      await page.waitForTimeout(250);
      const framePath = path.join(
        outputDir,
        `${String(index + 1).padStart(2, "0")}-${state}.png`,
      );
      await page.screenshot({ path: framePath, type: "png" });
      transitions.push({ state, target, framePath, renderError });
      await page.waitForTimeout(1_750);
    }
  } finally {
    await context.close();
    await browser.close();
    await new Promise((resolve) => previewServer.httpServer.close(resolve));
  }

  if (!video) {
    throw new Error("Playwright did not create a video");
  }
  const generatedVideoPath = await video.path();
  const webmPath = path.join(
    outputDir,
    "calendar-source-truth-walkthrough.webm",
  );
  fs.copyFileSync(generatedVideoPath, webmPath);
  const videoPath = path.join(
    outputDir,
    "calendar-source-truth-walkthrough.mp4",
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

  const diagnostics = {
    generatedAt: new Date().toISOString(),
    states,
    transitions,
    webmPath,
    videoPath,
    consoleErrors,
    pageErrors,
    requestFailures,
  };
  const diagnosticsPath = path.join(outputDir, "diagnostics.json");
  fs.writeFileSync(
    diagnosticsPath,
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );

  if (
    consoleErrors.length > 0 ||
    pageErrors.length > 0 ||
    requestFailures.length > 0
  ) {
    throw new Error(`walkthrough diagnostics failed: ${diagnosticsPath}`);
  }

  console.log(`[calendar-walkthrough] video: ${videoPath}`);
  console.log(`[calendar-walkthrough] diagnostics: ${diagnosticsPath}`);
}

// error-policy:J1 The CLI boundary turns capture failure into a visible non-zero exit.
main().catch((error) => {
  console.error("[calendar-walkthrough] FATAL", error);
  process.exit(1);
});
