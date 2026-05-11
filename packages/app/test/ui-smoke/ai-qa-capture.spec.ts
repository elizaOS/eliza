import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test } from "@playwright/test";
import {
  AI_QA_ROUTES,
  type AiQaRoute,
  type ReadyCheck,
  SETTINGS_SECTIONS,
  THEMES,
  type Theme,
  type ViewportName,
  VIEWPORT_SIZES,
} from "../../../../scripts/ai-qa/route-catalog";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

type ButtonRecord = {
  selector: string;
  role: string;
  text: string;
  testId: string | null;
  ariaLabel: string | null;
  href: string | null;
  disabled: boolean;
};

type Issue = { kind: string; detail: string };

type CaptureRecord = {
  routeId: string;
  routePath: string;
  viewport: ViewportName;
  theme: Theme;
  screenshotRelPath: string;
  buttonCount: number;
  buttons: ButtonRecord[];
  issues: Issue[];
  readyOk: boolean;
  navMs: number;
  capturedAt: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const RUN_ID = process.env.AI_QA_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_DIR = resolve(REPO_ROOT, "reports", "ai-qa", RUN_ID);

const ROUTE_FILTER = process.env.AI_QA_ROUTE_FILTER ?? "";
const VIEWPORT_FILTER = (process.env.AI_QA_VIEWPORTS ?? "desktop,mobile") as string;
const THEME_FILTER = (process.env.AI_QA_THEMES ?? "light,dark") as string;

const SELECTED_VIEWPORTS: readonly ViewportName[] = VIEWPORT_FILTER.split(",")
  .map((v) => v.trim())
  .filter((v): v is ViewportName => v === "desktop" || v === "tablet" || v === "mobile");

const SELECTED_THEMES: readonly Theme[] = THEME_FILTER.split(",")
  .map((t) => t.trim())
  .filter((t): t is Theme => t === "light" || t === "dark");

const ROUTES_TO_RUN: readonly AiQaRoute[] = ROUTE_FILTER
  ? AI_QA_ROUTES.filter((route) => {
      const filters = ROUTE_FILTER.split(",").map((f) => f.trim());
      return filters.some(
        (filter) => route.id === filter || route.id.startsWith(filter),
      );
    })
  : AI_QA_ROUTES;

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

function installPageIssueGuards(page: Page): Issue[] {
  const issues: Issue[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const location = message.location();
    issues.push({
      kind: `console.${message.type()}`,
      detail: `${message.text()}${
        location.url ? ` (${location.url}:${location.lineNumber})` : ""
      }`,
    });
  });
  page.on("pageerror", (error) => {
    issues.push({
      kind: "pageerror",
      detail: `${error.message}\n${error.stack ?? ""}`.trim(),
    });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failure = request.failure();
    issues.push({
      kind: "requestfailed",
      detail: `${request.method()} ${url} — ${failure?.errorText ?? "unknown"}`,
    });
  });
  return issues;
}

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((targetTheme) => {
    try {
      localStorage.setItem("eliza:theme-mode", targetTheme);
      localStorage.setItem("eliza-theme", targetTheme);
      document.documentElement.dataset.theme = targetTheme;
      document.documentElement.classList.toggle("dark", targetTheme === "dark");
      document.documentElement.classList.toggle("light", targetTheme === "light");
    } catch {}
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
}

async function checkReady(
  page: Page,
  checks: readonly ReadyCheck[],
  mode: "all" | "any",
  timeoutMs: number,
): Promise<boolean> {
  let anyPassed = false;
  let allPassed = true;
  for (const check of checks) {
    let passed = false;
    try {
      if ("selector" in check) {
        await page.locator(check.selector).first().waitFor({
          state: "visible",
          timeout: timeoutMs,
        });
        passed = true;
      } else {
        await page.getByText(check.text).first().waitFor({
          state: "visible",
          timeout: timeoutMs,
        });
        passed = true;
      }
    } catch {
      passed = false;
    }
    if (passed) anyPassed = true;
    if (!passed) allPassed = false;
  }
  return mode === "all" ? allPassed : anyPassed;
}

async function captureButtonInventory(page: Page): Promise<ButtonRecord[]> {
  const buttons = await page.evaluate(() => {
    const SELECTORS = [
      "button",
      "[role='button']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='switch']",
      "a[href]",
      "[data-testid]",
    ];
    const seen = new Set<Element>();
    const records: Array<{
      role: string;
      text: string;
      testId: string | null;
      ariaLabel: string | null;
      href: string | null;
      disabled: boolean;
      selector: string;
    }> = [];

    function describe(node: Element): string {
      const id = node.getAttribute("id");
      if (id) return `#${id}`;
      const testId = node.getAttribute("data-testid");
      if (testId) return `[data-testid="${testId}"]`;
      const ariaLabel = node.getAttribute("aria-label");
      if (ariaLabel) return `${node.tagName.toLowerCase()}[aria-label="${ariaLabel.slice(0, 60)}"]`;
      const text = (node.textContent ?? "").trim().slice(0, 40);
      if (text) return `${node.tagName.toLowerCase()}:has-text("${text}")`;
      return node.tagName.toLowerCase();
    }

    for (const selector of SELECTORS) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (seen.has(node)) continue;
        seen.add(node);
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const role =
          node.getAttribute("role") ?? node.tagName.toLowerCase();
        const text = (node.textContent ?? "").trim().slice(0, 80);
        const testId = node.getAttribute("data-testid");
        const ariaLabel = node.getAttribute("aria-label");
        const href = node.getAttribute("href");
        const disabled =
          node.hasAttribute("disabled") ||
          node.getAttribute("aria-disabled") === "true";
        records.push({
          role,
          text,
          testId,
          ariaLabel,
          href,
          disabled,
          selector: describe(node),
        });
      }
    }
    return records;
  });
  return buttons;
}

async function capture(args: {
  page: Page;
  route: AiQaRoute;
  viewport: ViewportName;
  theme: Theme;
  issues: Issue[];
}): Promise<CaptureRecord> {
  const { page, route, viewport, theme, issues } = args;
  const captureStarted = Date.now();
  const timeoutMs = route.timeoutMs ?? 30_000;
  await openAppPath(page, route.path);
  const readyOk = await checkReady(
    page,
    route.readyChecks,
    route.readyMode ?? "any",
    timeoutMs,
  );
  const navMs = Date.now() - captureStarted;

  const fileName = `${route.id}__${viewport}__${theme}.png`;
  const relDir = join("captures", route.id);
  const absDir = join(REPORT_DIR, relDir);
  await ensureDir(absDir);
  await page.screenshot({
    path: join(absDir, fileName),
    fullPage: false,
    type: "png",
  });

  let buttons: ButtonRecord[] = [];
  try {
    buttons = await captureButtonInventory(page);
  } catch (error) {
    issues.push({
      kind: "button-inventory-failed",
      detail: (error as Error).message,
    });
  }

  return {
    routeId: route.id,
    routePath: route.path,
    viewport,
    theme,
    screenshotRelPath: join(relDir, fileName),
    buttonCount: buttons.length,
    buttons,
    issues: [...issues],
    readyOk,
    navMs,
    capturedAt: new Date().toISOString(),
  };
}

test.describe("ai-qa capture", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await ensureDir(REPORT_DIR);
    const manifest = {
      runId: RUN_ID,
      startedAt: new Date().toISOString(),
      routes: ROUTES_TO_RUN.map((r) => ({
        id: r.id,
        path: r.path,
        label: r.label,
      })),
      viewports: SELECTED_VIEWPORTS,
      themes: SELECTED_THEMES,
      settingsSections: SETTINGS_SECTIONS.map((s) => ({
        id: s.id,
        label: s.label,
      })),
    };
    await writeFile(
      join(REPORT_DIR, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  });

  for (const route of ROUTES_TO_RUN) {
    for (const viewport of SELECTED_VIEWPORTS) {
      for (const theme of SELECTED_THEMES) {
        test(`${route.id} @ ${viewport} ${theme}`, async ({ browser }) => {
          test.setTimeout((route.timeoutMs ?? 30_000) + 60_000);
          const context = await browser.newContext({
            viewport: VIEWPORT_SIZES[viewport],
            colorScheme: theme,
          });
          const page = await context.newPage();
          const issues = installPageIssueGuards(page);
          await seedAppStorage(page);
          await applyTheme(page, theme);
          await installDefaultAppRoutes(page);
          let record: CaptureRecord;
          try {
            record = await capture({ page, route, viewport, theme, issues });
          } catch (error) {
            issues.push({
              kind: "capture-error",
              detail: (error as Error).message,
            });
            record = {
              routeId: route.id,
              routePath: route.path,
              viewport,
              theme,
              screenshotRelPath: "",
              buttonCount: 0,
              buttons: [],
              issues: [...issues],
              readyOk: false,
              navMs: 0,
              capturedAt: new Date().toISOString(),
            };
          }
          await writeFile(
            join(
              REPORT_DIR,
              "captures",
              route.id,
              `${route.id}__${viewport}__${theme}.json`,
            ),
            JSON.stringify(record, null, 2),
          );
          await context.close();
        });
      }
    }
  }

  test("settings sub-sections @ desktop light", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({
      viewport: VIEWPORT_SIZES.desktop,
      colorScheme: "light",
    });
    const page = await context.newPage();
    const issues = installPageIssueGuards(page);
    await seedAppStorage(page);
    await applyTheme(page, "light");
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/settings");
    await page
      .locator('[data-testid="settings-shell"]')
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });

    const records: CaptureRecord[] = [];
    for (const section of SETTINGS_SECTIONS) {
      try {
        await openSettingsSection(page, section.match);
      } catch (error) {
        issues.push({
          kind: `settings-section-missing:${section.id}`,
          detail: (error as Error).message,
        });
        continue;
      }
      await page.waitForTimeout(400);
      const fileName = `${section.id}__desktop__light.png`;
      const relDir = join("captures", section.id);
      const absDir = join(REPORT_DIR, relDir);
      await ensureDir(absDir);
      await page.screenshot({
        path: join(absDir, fileName),
        fullPage: false,
        type: "png",
      });
      const buttons = await captureButtonInventory(page).catch(() => []);
      records.push({
        routeId: section.id,
        routePath: "/settings",
        viewport: "desktop",
        theme: "light",
        screenshotRelPath: join(relDir, fileName),
        buttonCount: buttons.length,
        buttons,
        issues: [],
        readyOk: true,
        navMs: 0,
        capturedAt: new Date().toISOString(),
      });
    }
    await writeFile(
      join(REPORT_DIR, "captures", "settings-sections.json"),
      JSON.stringify({ sections: records, issues }, null, 2),
    );
    await context.close();
  });
});
