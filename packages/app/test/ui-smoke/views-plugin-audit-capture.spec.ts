// Opt-in plugin/dynamic view capture for the 2026-07-04 views UX audit. This
// is intentionally capture-first: it records every registered plugin view case
// and writes an audit manifest, even when the route falls back or the backend is
// unavailable. The point is evidence, not a green health assertion.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import { VIEW_CASES, type ViewCase } from "./plugin-view-cases";

const OUT_DIR = path.join(
  process.cwd(),
  "test-results",
  "ui-smoke-artifacts",
  "views-ux-audit-2026-07-04",
  "plugin-view-sweep",
);

const VIEWPORTS = [
  { name: "desktop", size: { width: 1440, height: 1000 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;

type PluginCaptureRecord = {
  viewport: string;
  id: string;
  viewType: ViewCase["viewType"];
  path: string;
  screenshot: string;
  url: string;
  status:
    | "captured"
    | "failed-loader"
    | "home-fallback"
    | "view-manager-fallback"
    | "capture-error";
  visibleTextSample: string;
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
};

async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function classifyCapture(text: string): PluginCaptureRecord["status"] {
  if (/Failed to load view/i.test(text)) return "failed-loader";
  if (/^View Manager \d+ views\b/.test(text)) return "view-manager-fallback";
  if (
    /Welcome .* ask me anything to get started/i.test(text) &&
    /ChatSettingsWalletTasksBrowser/i.test(text)
  ) {
    return "home-fallback";
  }
  return "captured";
}

async function captureViewCase(
  page: Page,
  viewport: string,
  view: ViewCase,
): Promise<PluginCaptureRecord> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let navigationError: string | null = null;
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const screenshot = `${viewport}-${view.id}-${view.viewType}.png`;
  try {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page
      .goto(view.path, {
        waitUntil: "commit",
        timeout: 5_000,
      })
      .catch((error) => {
        navigationError =
          error instanceof Error ? error.message : String(error);
        return null;
      });
    await page.locator("#root").waitFor({ state: "attached", timeout: 5_000 });
    await page.waitForTimeout(600);

    const body = page.locator("body");
    await body.waitFor({ state: "visible", timeout: 5_000 });
    const visibleText = await body.evaluate((node) =>
      (node.textContent ?? "").trim().replace(/\s+/g, " "),
    );
    await mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({
      fullPage: false,
      path: path.join(OUT_DIR, screenshot),
      type: "png",
    });

    return {
      viewport,
      id: view.id,
      viewType: view.viewType,
      path: view.path,
      screenshot,
      url: page.url(),
      status: classifyCapture(visibleText),
      visibleTextSample: visibleText.slice(0, 1000),
      consoleErrors: navigationError
        ? [`navigation warning: ${navigationError}`, ...consoleErrors]
        : consoleErrors,
      pageErrors,
    };
  } catch (error) {
    return {
      viewport,
      id: view.id,
      viewType: view.viewType,
      path: view.path,
      screenshot,
      url: page.url(),
      status: "capture-error",
      visibleTextSample: "",
      consoleErrors,
      pageErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

test.describe("plugin views UX audit capture", () => {
  test.skip(
    process.env.ELIZA_PLUGIN_VIEWS_AUDIT !== "1",
    "plugin views audit capture is opt-in",
  );

  for (const viewport of VIEWPORTS) {
    for (const view of VIEW_CASES) {
      test(`capture plugin view ${viewport.name} ${view.id} ${view.viewType}`, async ({
        page,
      }) => {
        test.setTimeout(20_000);
        await page.setViewportSize(viewport.size);
        const record = await captureViewCase(page, viewport.name, view);
        await writeJson(`${viewport.name}-${view.id}-${view.viewType}`, record);
      });
    }
  }
});
