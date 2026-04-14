/**
 * Onboarding E2E screenshot runner.
 *
 * Walks through every onboarding step, screenshots each one at multiple
 * viewports, then generates an HTML gallery alongside the design-review output.
 *
 * Usage:
 *   npx tsx apps/app/test/design-review/run-onboarding-review.ts
 *   ELIZA_DESIGN_REVIEW_HEADLESS=1 npx tsx apps/app/test/design-review/run-onboarding-review.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { startMockApiServer } from "../electrobun-packaged/mock-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewportId =
  | "mobile-portrait"
  | "mobile-landscape"
  | "desktop-landscape"
  | "ipad-portrait";

interface ViewportSpec {
  id: ViewportId;
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
  hasTouch: boolean;
}

interface StepSpec {
  id: string;
  label: string;
  /** Action to take BEFORE screenshotting this step. null = first step. */
  setup: ((page: Page) => Promise<void>) | null;
  expectedContent: readonly (string | RegExp)[];
}

interface CaptureRecord {
  stepId: string;
  stepLabel: string;
  viewportId: ViewportId;
  viewportLabel: string;
  viewportSize: string;
  relativePath: string;
}

interface FailureRecord {
  stepId: string;
  viewportId: ViewportId;
  message: string;
  screenshotPath?: string;
  consolePath?: string;
}

interface Manifest {
  generatedAt: string;
  appBaseUrl: string;
  captures: CaptureRecord[];
  failures: FailureRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const READY_TIMEOUT_MS = 30_000;
const SETTLE_MS = Number.parseInt(
  process.env.ELIZA_DESIGN_REVIEW_SETTLE_MS ?? "1500",
  10,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "../..");
const outputRoot = path.resolve(
  appRoot,
  "test-results/design-review/onboarding",
);
const screenshotsRoot = path.join(outputRoot, "screenshots");
const diagnosticsRoot = path.join(outputRoot, "diagnostics");

// ---------------------------------------------------------------------------
// Viewports
// ---------------------------------------------------------------------------

const viewports: ViewportSpec[] = [
  {
    id: "mobile-portrait",
    label: "Mobile Portrait",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "mobile-landscape",
    label: "Mobile Landscape",
    width: 844,
    height: 390,
    isMobile: true,
    hasTouch: true,
  },
  {
    id: "desktop-landscape",
    label: "Desktop Landscape",
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  },
  {
    id: "ipad-portrait",
    label: "iPad Portrait",
    width: 820,
    height: 1180,
    isMobile: true,
    hasTouch: true,
  },
];

const ONBOARDING_PERMISSION_FLOW =
  process.env.ELIZA_DESIGN_REVIEW_PERMISSIONS_PATH === "grant"
    ? "grant"
    : "skip";

async function waitForVisibleTextFallback(
  page: Page,
  labels: readonly (string | RegExp)[],
  options?: { exact?: boolean },
): Promise<void> {
  for (const label of labels) {
    const locator =
      typeof label === "string"
        ? page.getByText(label, { exact: options?.exact ?? true }).first()
        : page.getByText(label).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
      return;
    }
  }
  throw new Error(
    `Could not find any of: ${labels.map((label) => String(label)).join(", ")}`,
  );
}

async function clickVisibleTextFallback(
  page: Page,
  labels: readonly (string | RegExp)[],
): Promise<void> {
  for (const label of labels) {
    const locator =
      typeof label === "string"
        ? page.getByText(label, { exact: true }).first()
        : page.getByText(label).first();
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }
    await locator.click();
    return;
  }
  throw new Error(
    `Could not find any of: ${labels.map((label) => String(label)).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Onboarding step definitions
// ---------------------------------------------------------------------------

const steps: StepSpec[] = [
  {
    id: "01-cloud-login",
    label: "Eliza Cloud — Account",
    setup: null, // First step, just navigate
    expectedContent: [/Log in with Eliza Cloud/i, /^Skip$/i],
  },
  {
    id: "02-identity",
    label: "Identity — Choose Agent",
    setup: async (page) => {
      // Use the stable offline path so the full onboarding flow stays local.
      const skipButton = page
        .getByRole("button", { name: /^(Skip|Continue Offline)$/i })
        .first();
      await skipButton.click();
      await page.waitForTimeout(600);
    },
    expectedContent: [/Continue/i, /Chen/i],
  },
  {
    id: "03-connection-hosting",
    label: "Connection — Hosting Selection",
    setup: async (page) => {
      await page
        .getByRole("button", { name: /Continue/i })
        .first()
        .click();
      await page.waitForTimeout(600);
    },
    expectedContent: [/Where should .* run\?/i, /^Local$/i],
  },
  {
    id: "04-connection-provider",
    label: "Connection — Provider Selection",
    setup: async (page) => {
      // Select local hosting to advance into the provider list.
      await page.getByRole("button", { name: /Local/i }).first().click();
      await page.waitForTimeout(600);
    },
    expectedContent: [/Choose your AI provider/i, /Ollama/i],
  },
  {
    id: "05-connection-config",
    label: "Connection — Provider Config",
    setup: async (page) => {
      // Select a stable provider so the detail/config panel renders.
      await page
        .getByRole("button", { name: /Ollama/i })
        .first()
        .click();
      await page.waitForTimeout(600);
    },
    expectedContent: [/Local models/i, /Confirm/i],
  },
  {
    id: "06-voice",
    label: "Voice — Provider",
    setup: async (page) => {
      // Confirm the provider choice to advance to voice setup.
      await page
        .getByRole("button", { name: /Confirm/i })
        .first()
        .click();
      await page.waitForTimeout(600);
    },
    expectedContent: [/Choose your preferred voice provider/i, /^Skip$/i],
  },
  {
    id: "07-permissions",
    label: "Permissions — System Access",
    setup: async (page) => {
      await clickVisibleTextFallback(page, ["Skip", "Next"]);
      await page.waitForTimeout(600);
    },
    expectedContent: [/Browser Permissions/i, /Continue/i],
  },
  {
    id: "08-activate",
    label: "Activate — Ready",
    setup: async (page) => {
      // Default to the stable skip path. Grant-path captures can be enabled via
      // ELIZA_DESIGN_REVIEW_PERMISSIONS_PATH=grant when needed.
      if (ONBOARDING_PERMISSION_FLOW === "grant") {
        await clickVisibleTextFallback(page, [
          "Grant Permissions",
          "Grant",
          "Allow All Permissions",
          "Allow All",
          "Continue",
        ]);
      } else {
        await clickVisibleTextFallback(page, [
          "Skip for Now",
          "Skip for now",
          "Continue",
        ]);
      }
      await page.waitForTimeout(600);
    },
    expectedContent: [/Setup is complete/i, /^Enter$/i],
  },
];

// ---------------------------------------------------------------------------
// Infra helpers (simplified from design-review runner)
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startAppServer(apiBaseUrl: string): Promise<{
  server: ViteDevServer;
  baseUrl: string;
}> {
  process.env.ELIZA_API_PORT = new URL(apiBaseUrl).port;
  const port = await getFreePort();
  const server = await createViteServer({
    configFile: path.join(appRoot, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
      hmr: false,
      watch: null,
    },
  });
  await server.listen();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function createPage(
  browser: Browser,
  apiBaseUrl: string,
  viewport: ViewportSpec,
): Promise<{
  context: BrowserContext;
  page: Page;
  consoleLines: string[];
}> {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    deviceScaleFactor: 1,
  });

  // Pre-initialize storage so the app loads fresh into onboarding
  await context.addInitScript(
    (init) => {
      try {
        window.localStorage.clear();
        window.sessionStorage.clear();
        window.localStorage.setItem("eliza:ui-language", "en");
        window.localStorage.setItem("eliza:ui-theme", "dark");
        window.localStorage.setItem("eliza:ui-shell-mode", "native");
        window.localStorage.setItem("eliza:ui-language", "en");
        window.localStorage.setItem("eliza:ui-theme", "dark");
        window.localStorage.setItem("eliza:ui-shell-mode", "native");
        window.sessionStorage.setItem("eliza_api_base", init.apiBaseUrl);
        Object.assign(window, { __ELIZA_API_BASE__: init.apiBaseUrl });
      } catch {
        // Ignore storage setup failures on intermediate documents
      }
    },
    { apiBaseUrl },
  );

  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    consoleLines.push(`[${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`[pageerror] ${error.message}`);
  });

  // Intercept /api/config to return an empty config so onboarding doesn't
  // resume from a partially-configured state (the mock API returns cloud
  // config by default which causes the app to skip to "senses").
  await page.route("**/api/config", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ settings: {}, env: { vars: {} } }),
      });
    }
    return route.continue();
  });

  // Always report onboarding as not complete so each viewport run starts fresh.
  await page.route("**/api/onboarding/status", (route) => {
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ complete: false }),
    });
  });

  // Swallow the onboarding submit POST so the mock doesn't flip its state.
  await page.route("**/api/onboarding", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.continue();
  });

  return { context, page, consoleLines };
}

async function waitForPageLoaded(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", {
    timeout: READY_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => document.readyState === "complete",
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
}

async function waitForTransientUi(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // The AvatarLoader renders "LOADING" text in a fixed overlay.
    // Check for both the LOADING text and loading-screen class.
    const loadingTextVisible = await page
      .locator("text=LOADING")
      .first()
      .isVisible()
      .catch(() => false);
    const loadingScreenVisible = await page
      .locator(".loading-screen")
      .first()
      .isVisible()
      .catch(() => false);
    if (!loadingTextVisible && !loadingScreenVisible) return;
    await page.waitForTimeout(300);
  }
}

async function waitForSettled(page: Page): Promise<void> {
  await waitForTransientUi(page);
  // Wait for fonts
  await page.evaluate(async () => {
    if ("fonts" in document) await document.fonts.ready;
  });
  // Final settle time for animations
  await page.waitForTimeout(SETTLE_MS);
}

// ---------------------------------------------------------------------------
// Gallery generation
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeGallery(manifest: Manifest): Promise<void> {
  const byStep = new Map<string, CaptureRecord[]>();
  for (const capture of manifest.captures) {
    const existing = byStep.get(capture.stepId) ?? [];
    existing.push(capture);
    byStep.set(capture.stepId, existing);
  }

  const dateLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(manifest.generatedAt));

  const sections = steps
    .map((step) => {
      const captures = byStep.get(step.id);
      if (!captures?.length) return "";
      return `
        <section class="view-section">
          <div class="view-header">
            <h2>${escapeHtml(step.label)}</h2>
            <p>Step: ${escapeHtml(step.id)}</p>
          </div>
          <div class="shot-grid">
            ${captures
              .map(
                (capture) => `
                  <figure class="shot">
                    <img src="./${escapeHtml(capture.relativePath)}" alt="${escapeHtml(
                      `${capture.stepLabel} ${capture.viewportLabel}`,
                    )}" loading="lazy" />
                    <figcaption>
                      <strong>${escapeHtml(capture.viewportLabel)}</strong>
                      <span>${escapeHtml(capture.viewportSize)}</span>
                    </figcaption>
                  </figure>`,
              )
              .join("")}
          </div>
        </section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Eliza Onboarding Review</title>
    <style>
      :root { color-scheme: dark; --bg: #090b0f; --panel: #11161d; --panel-2: #171e28; --border: rgba(255, 255, 255, 0.08); --text: #edf2f7; --muted: #9aa8bc; --accent: #f0b232; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: radial-gradient(circle at top, rgba(240, 178, 50, 0.16), transparent 30%), linear-gradient(180deg, #0b0f14 0%, var(--bg) 100%); color: var(--text); }
      main { width: min(1800px, calc(100vw - 40px)); margin: 0 auto; padding: 32px 0 64px; }
      h1, h2, p { margin: 0; }
      header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
      .meta { color: var(--muted); font-size: 14px; }
      .view-section { margin-top: 28px; padding: 18px; border: 1px solid var(--border); border-radius: 20px; background: linear-gradient(180deg, rgba(23, 30, 40, 0.94), rgba(13, 18, 24, 0.96)); }
      .view-header { display: flex; justify-content: space-between; gap: 8px 16px; margin-bottom: 16px; flex-wrap: wrap; }
      .view-header p { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
      .shot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
      .shot { margin: 0; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--panel); }
      .shot img { display: block; width: 100%; height: auto; background: #05070a; }
      figcaption { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; background: var(--panel-2); }
      figcaption span { color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Eliza Onboarding Review</h1>
          <p class="meta">${escapeHtml(
            `${dateLabel} · ${manifest.captures.length} screenshots · ${steps.length} steps`,
          )}</p>
        </div>
      </header>
      ${sections}
      ${
        manifest.failures.length
          ? `<section class="view-section">
            <div class="view-header"><h2>Failures</h2></div>
            <ul>${manifest.failures
              .map(
                (f) =>
                  `<li><strong>${escapeHtml(f.stepId)} · ${escapeHtml(f.viewportId)}</strong>: ${escapeHtml(f.message)}</li>`,
              )
              .join("")}</ul>
          </section>`
          : ""
      }
    </main>
  </body>
</html>`;

  await writeFile(path.join(outputRoot, "index.html"), html, "utf8");
}

// ---------------------------------------------------------------------------
// Capture logic
// ---------------------------------------------------------------------------

async function captureOnboardingFlow(
  browser: Browser,
  appBaseUrl: string,
  apiBaseUrl: string,
  viewport: ViewportSpec,
): Promise<{ captures: CaptureRecord[]; failures: FailureRecord[] }> {
  const captures: CaptureRecord[] = [];
  const failures: FailureRecord[] = [];

  const { context, page, consoleLines } = await createPage(
    browser,
    apiBaseUrl,
    viewport,
  );

  try {
    // Navigate to app root — should show onboarding since mock API has onboardingComplete=false
    await page.goto(appBaseUrl, {
      waitUntil: "commit",
      timeout: READY_TIMEOUT_MS,
    });
    await waitForPageLoaded(page);
    await waitForSettled(page);

    // Wait for loading screen to disappear and the first onboarding screen to appear.
    // The flow now opens directly on Eliza Cloud login instead of a welcome CTA.
    await waitForSettled(page);
    try {
      await waitForVisibleTextFallback(page, [
        "Log in with Eliza Cloud",
        "Continue Offline",
        "Skip",
      ]);
    } catch {
      // If Welcome text not found, take diagnostic screenshot
      await mkdir(diagnosticsRoot, { recursive: true });
      const diagPath = path.join(
        diagnosticsRoot,
        `initial-load--${viewport.id}.png`,
      );
      await page
        .screenshot({ path: diagPath, fullPage: false })
        .catch(() => {});
      const html = await page.content().catch(() => "");
      await writeFile(
        path.join(diagnosticsRoot, `initial-load--${viewport.id}.html`),
        html,
        "utf8",
      );
      await writeFile(
        path.join(diagnosticsRoot, `initial-load--${viewport.id}.log`),
        consoleLines.join("\n"),
        "utf8",
      );
      failures.push({
        stepId: "initial-load",
        viewportId: viewport.id,
        message: `Welcome screen did not appear for ${viewport.id}. See diagnostics.`,
        screenshotPath: path.relative(outputRoot, diagPath),
        consolePath: path.relative(
          outputRoot,
          path.join(diagnosticsRoot, `initial-load--${viewport.id}.log`),
        ),
      });
      console.error(
        `  ✗ initial-load · ${viewport.id}: Welcome screen did not appear`,
      );
      return { captures, failures };
    }
    await page.waitForTimeout(800);

    for (const step of steps) {
      try {
        // Execute the step's setup action (advance to this step)
        if (step.setup) {
          await step.setup(page);
          await waitForSettled(page);
        }

        await waitForVisibleTextFallback(page, step.expectedContent, {
          exact: false,
        });

        // Take the screenshot
        const relativePath = path.posix.join(
          "screenshots",
          step.id,
          `${viewport.id}.png`,
        );
        const absolutePath = path.join(outputRoot, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await page.screenshot({ path: absolutePath, fullPage: false });

        captures.push({
          stepId: step.id,
          stepLabel: step.label,
          viewportId: viewport.id,
          viewportLabel: viewport.label,
          viewportSize: `${viewport.width}x${viewport.height}`,
          relativePath,
        });

        console.log(`  ✓ ${step.id} · ${viewport.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${step.id} · ${viewport.id}: ${message}`);

        // Save diagnostics
        await mkdir(diagnosticsRoot, { recursive: true });
        const stem = `${step.id}--${viewport.id}`;
        const diagScreenshot = path.join(diagnosticsRoot, `${stem}.png`);
        const diagConsole = path.join(diagnosticsRoot, `${stem}.log`);
        await page
          .screenshot({ path: diagScreenshot, fullPage: false })
          .catch(() => {});
        await writeFile(diagConsole, `${consoleLines.join("\n")}\n`, "utf8");

        failures.push({
          stepId: step.id,
          viewportId: viewport.id,
          message,
          screenshotPath: path.relative(outputRoot, diagScreenshot),
          consolePath: path.relative(outputRoot, diagConsole),
        });

        // Stop this viewport's flow — subsequent steps depend on this one
        break;
      }
    }
  } finally {
    await context.close();
  }

  return { captures, failures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Onboarding Review — starting...\n");

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(screenshotsRoot, { recursive: true });

  // Start mock API with onboarding NOT complete so we see the onboarding flow
  const api = await startMockApiServer({ onboardingComplete: false, port: 0 });
  const { server, baseUrl: appBaseUrl } = await startAppServer(api.baseUrl);
  const browser = await chromium.launch({
    headless: process.env.ELIZA_DESIGN_REVIEW_HEADLESS === "1",
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-webgpu",
    ],
    timeout: 300_000,
  });

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    appBaseUrl,
    captures: [],
    failures: [],
  };

  try {
    for (const viewport of viewports) {
      console.log(`\n[${viewport.label}] ${viewport.width}x${viewport.height}`);
      const result = await captureOnboardingFlow(
        browser,
        appBaseUrl,
        api.baseUrl,
        viewport,
      );
      manifest.captures.push(...result.captures);
      manifest.failures.push(...result.failures);
    }
  } finally {
    await browser.close();
    await server.close();
    await api.close();
  }

  await writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeGallery(manifest);

  console.log(
    `\nWrote ${manifest.captures.length} screenshots to ${outputRoot}`,
  );
  console.log(`Gallery: ${path.join(outputRoot, "index.html")}`);

  if (manifest.failures.length) {
    console.error(`\nEncountered ${manifest.failures.length} failures.`);
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
