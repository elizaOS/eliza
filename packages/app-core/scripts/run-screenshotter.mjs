#!/usr/bin/env node
/**
 * Run the VRM screenshotter via Playwright: generate preview images and save to public/vrms/previews.
 *
 * Requires the Vite dev server to be running (bun run dev) and raw .vrm files in public_src/vrms.
 *
 * Usage:
 *   node scripts/run-screenshotter.mjs
 *   node scripts/run-screenshotter.mjs --url http://localhost:2138
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const PREVIEWS_DIR = path.join(
  ROOT,
  "apps",
  "app",
  "public",
  "vrms",
  "previews",
);
const BACKGROUNDS_DIR = path.join(
  ROOT,
  "apps",
  "app",
  "public",
  "vrms",
  "backgrounds",
);
const VRM_COUNT = 8;

function parseArgs() {
  const args = process.argv.slice(2);
  let url = "http://localhost:2138";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1];
      i++;
    }
  }
  return { url };
}

async function main() {
  const { url } = parseArgs();
  const screenshotterUrl = `${url}/public_src/screenshotter.html`;

  console.log("[run-screenshotter] Launching browser...");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--ignore-gpu-blocklist",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--disable-gpu-sandbox",
      "--no-sandbox",
    ],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(180000);

  try {
    console.log("[run-screenshotter] Loading screenshotter...");
    const response = await page.goto(screenshotterUrl, {
      waitUntil: "networkidle",
      timeout: 15000,
    });
    if (!response?.ok()) {
      throw new Error(
        `Failed to load screenshotter: ${response?.status()} ${response?.statusText()}. Is the dev server running? Try: bun run dev`,
      );
    }

    console.log("[run-screenshotter] Clicking Generate All Previews...");
    await page.click("#run-all");

    await page.waitForSelector(".card.loading, .card.done, .card.error", {
      timeout: 10000,
    });

    console.log("[run-screenshotter] Waiting for all previews to render...");
    await page.waitForFunction(
      () => {
        const done = document.querySelectorAll(".card.done").length;
        const error = document.querySelectorAll(".card.error").length;
        const total = document.querySelectorAll(".card").length;
        return done + error >= total;
      },
      { timeout: 180000 },
    );

    const errors = await page.$$eval(".card.error", (els) =>
      els.map((e) => e.querySelector(".label")?.textContent ?? "unknown"),
    );
    if (errors.length > 0) {
      console.warn("[run-screenshotter] Some cards failed:", errors);
    }

    fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
    fs.mkdirSync(BACKGROUNDS_DIR, { recursive: true });

    let saved = 0;
    for (let i = 1; i <= VRM_COUNT; i++) {
      const dataUrl = await page.evaluate((index) => {
        const dl = document.getElementById(`d${index}`);
        return dl?.href ?? null;
      }, i);
      if (!dataUrl?.startsWith("data:image/png")) {
        console.warn(`[run-screenshotter] No preview for eliza-${i}`);
        continue;
      }
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      const buf = Buffer.from(base64, "base64");
      const previewPath = path.join(PREVIEWS_DIR, `eliza-${i}.png`);
      fs.writeFileSync(previewPath, buf);
      console.log(`[run-screenshotter] Saved ${previewPath}`);
      saved++;

      const bgPath = path.join(BACKGROUNDS_DIR, `eliza-${i}.png`);
      fs.writeFileSync(bgPath, buf);
    }

    console.log(
      `[run-screenshotter] Done. Saved ${saved}/${VRM_COUNT} previews and backgrounds.`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[run-screenshotter]", err.message);
  process.exit(1);
});
