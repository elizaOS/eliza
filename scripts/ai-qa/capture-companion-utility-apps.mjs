#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const PORTS_FILE = join(HERE, ".static-stack.json");
const RUN_ID =
  process.env.AI_QA_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_DIR = resolve(
  REPO_ROOT,
  "reports",
  "apps-manual-qa",
  `companion-utility-${RUN_ID}`,
);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844, isMobile: true },
};

const RED_ERROR_TEXT =
  /Could not open app|Something went wrong|Cannot read properties|Unhandled Runtime Error|Traceback|TypeError:|ReferenceError:/i;

const BASE_ROUTES = [
  {
    name: "lifeops",
    path: "/apps/lifeops",
    ready: { selector: '[data-testid="lifeops-shell"]' },
  },
  {
    name: "tasks",
    path: "/apps/tasks",
    ready: { selector: '[data-testid="tasks-view"]' },
  },
  {
    name: "plugins",
    path: "/apps/plugins",
    ready: { text: "AI Providers" },
  },
  {
    name: "skills",
    path: "/apps/skills",
    ready: { selector: '[data-testid="skills-shell"]' },
  },
  {
    name: "fine-tuning",
    path: "/apps/fine-tuning",
    ready: { selector: '[data-testid="fine-tuning-view"]' },
  },
  {
    name: "trajectories",
    path: "/apps/trajectories",
    ready: { selector: '[data-testid="trajectories-view"]' },
  },
  {
    name: "relationships",
    path: "/apps/relationships",
    ready: { selector: '[data-testid="relationships-view"]' },
  },
  {
    name: "memories",
    path: "/apps/memories",
    ready: { selector: '[data-testid="memory-viewer-view"]' },
  },
  {
    name: "runtime",
    path: "/apps/runtime",
    ready: { selector: '[data-testid="runtime-view"]' },
  },
  {
    name: "database",
    path: "/apps/database",
    ready: { selector: '[data-testid="database-view"]' },
  },
  {
    name: "logs",
    path: "/apps/logs",
    ready: { selector: '[data-testid="logs-view"]' },
  },
  {
    name: "inventory",
    path: "/apps/inventory",
    ready: { selector: '[data-testid="wallet-shell"]' },
  },
  {
    name: "elizamaker",
    path: "/apps/elizamaker",
    ready: { selector: '[data-testid="chat-composer-textarea"]' },
  },
  {
    name: "companion",
    path: "/apps/companion",
    ready: { selector: '[data-testid="companion-root"]' },
  },
  {
    name: "shopify",
    path: "/apps/shopify",
    ready: { selector: '[data-testid="shopify-shell"]' },
  },
  {
    name: "vincent",
    path: "/apps/vincent",
    ready: { selector: '[data-testid="vincent-shell"]' },
  },
  {
    name: "hyperliquid",
    path: "/apps/hyperliquid",
    ready: { selector: '[data-testid="hyperliquid-shell"]' },
  },
  {
    name: "polymarket",
    path: "/apps/polymarket",
    ready: { selector: '[data-testid="polymarket-shell"]' },
  },
];

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readUiBase() {
  const raw = await readFile(PORTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.uiBase) throw new Error("Missing uiBase in .static-stack.json");
  return parsed.uiBase;
}

async function verifyStaticStack(uiBase) {
  const statusUrl = `${uiBase}/api/status`;
  let response;
  try {
    response = await fetch(statusUrl);
  } catch (error) {
    throw new Error(
      `Static QA stack is not reachable at ${statusUrl}. Restart it with scripts/ai-qa/static-stack.mjs. Cause: ${String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Static QA stack status failed at ${statusUrl}: ${response.status} ${body}`,
    );
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.state !== "running") {
    throw new Error(
      `Static QA stack is not running at ${statusUrl}: ${JSON.stringify(payload)}`,
    );
  }
}

async function readRoutes() {
  return Object.keys(VIEWPORTS).flatMap((viewport) =>
    BASE_ROUTES.map((route) => ({
      ...route,
      viewport,
    })),
  );
}

async function seedPage(page) {
  await page.addInitScript(() => {
    const storage = {
      "eliza:onboarding-complete": "1",
      "eliza:onboarding:step": "activate",
      "eliza:ui-theme": "dark",
      "elizaos:ui-theme": "dark",
      "elizaos:active-server": JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    };
    for (const [key, value] of Object.entries(storage)) {
      localStorage.setItem(key, value);
    }
  });
}

function installIssueCapture(page) {
  const logs = [];
  const issues = [];
  page.on("console", (message) => {
    const entry = {
      type: message.type(),
      text: message.text(),
      location: message.location(),
    };
    logs.push(entry);
    if (message.type() === "error" || RED_ERROR_TEXT.test(message.text())) {
      issues.push({ kind: `console.${message.type()}`, detail: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ kind: "pageerror", detail: error.message });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const failure = request.failure()?.errorText ?? "unknown";
    if (failure === "net::ERR_ABORTED") return;
    issues.push({
      kind: "requestfailed",
      detail: `${request.method()} ${url} ${failure}`,
    });
  });
  return { logs, issues };
}

async function waitReady(page, ready) {
  if (!ready) {
    await page.locator("#root").waitFor({ state: "visible", timeout: 60_000 });
    return;
  }
  if (ready.selector) {
    await page.locator(ready.selector).waitFor({
      state: "visible",
      timeout: 60_000,
    });
    return;
  }
  if (ready.text) {
    await page.getByText(ready.text, { exact: false }).first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  }
}

async function waitAppSpecificReady(page, routeName) {
  if (routeName !== "companion") return;
  await page
    .locator('[data-testid="companion-root"][data-avatar-ready="true"]')
    .waitFor({ state: "visible", timeout: 90_000 });
  await page
    .locator('[data-testid="companion-vrm-stage"][data-vrm-loaded="true"]')
    .waitFor({ state: "visible", timeout: 90_000 });
}

async function inspectPage(page) {
  return page.evaluate((redPattern) => {
    const red = new RegExp(redPattern, "i");
    const bodyText = document.body.innerText ?? "";
    return {
      title: document.title,
      bodyHasRedError: red.test(bodyText),
      buttons: document.querySelectorAll("button").length,
      visibleElementCount: Array.from(document.querySelectorAll("body *")).filter(
        (node) => {
          const element = node;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none"
          );
        },
      ).length,
      textLength: bodyText.length,
      textSample: bodyText.slice(0, 700),
      scroll: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      hasHorizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 2,
    };
  }, RED_ERROR_TEXT.source);
}

async function captureOne({ browser, uiBase, route }) {
  const viewport = VIEWPORTS[route.viewport];
  const context = await browser.newContext({
    viewport,
    colorScheme: "dark",
    isMobile: viewport.isMobile === true,
  });
  const page = await context.newPage();
  await seedPage(page);
  const { logs, issues } = installIssueCapture(page);
  const screenshot = `screenshots/${route.name}__${route.viewport}.png`;
  const url = `${uiBase}/?appWindow=1&manualQa=${encodeURIComponent(`${RUN_ID}-${route.viewport}-${route.name}`)}#${route.path}`;
  let readyOk = false;
  let navError = null;
  const startedAt = Date.now();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitReady(page, route.ready);
    await waitAppSpecificReady(page, route.name);
    readyOk = true;
    await page.waitForTimeout(500);
  } catch (error) {
    navError = error instanceof Error ? error.message : String(error);
    issues.push({ kind: "capture-error", detail: navError });
  }

  await ensureDir(join(REPORT_DIR, "screenshots"));
  await page.screenshot({
    path: join(REPORT_DIR, screenshot),
    fullPage: false,
    type: "png",
  });
  const inspection = await inspectPage(page);
  await context.close();

  return {
    name: route.name,
    path: route.path,
    viewport: route.viewport,
    screenshot,
    url,
    readyOk,
    navMs: Date.now() - startedAt,
    navError,
    issues,
    logs,
    inspection,
    verdict:
      readyOk &&
      !inspection.bodyHasRedError &&
      !inspection.hasHorizontalOverflow &&
      issues.length === 0
        ? "pass"
        : "review",
  };
}

async function makeContactSheet(records, viewport) {
  const rows = records.filter((record) => record.viewport === viewport);
  if (rows.length === 0) return;

  const tileWidth = viewport === "desktop" ? 480 : 220;
  const labelHeight = 28;
  const gap = 12;
  const columns = viewport === "desktop" ? 3 : 6;
  const composites = [];
  const tileHeight = viewport === "desktop" ? 300 : 300;
  const sheetWidth = columns * tileWidth + (columns + 1) * gap;
  const sheetHeight =
    Math.ceil(rows.length / columns) * (tileHeight + labelHeight + gap) + gap;

  for (let index = 0; index < rows.length; index += 1) {
    const record = rows[index];
    const left = gap + (index % columns) * (tileWidth + gap);
    const top = gap + Math.floor(index / columns) * (tileHeight + labelHeight + gap);
    const screenshotPath = join(REPORT_DIR, record.screenshot);
    if (!existsSync(screenshotPath)) continue;
    const image = await sharp(screenshotPath)
      .resize(tileWidth, tileHeight, { fit: "contain", background: "#09090b" })
      .png()
      .toBuffer();
    const label = await sharp({
      create: {
        width: tileWidth,
        height: labelHeight,
        channels: 4,
        background: "#111116",
      },
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${tileWidth}" height="${labelHeight}"><text x="0" y="20" fill="#f4f4f5" font-size="18" font-family="Arial">${record.name}</text></svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
    composites.push({ input: label, left, top });
    composites.push({ input: image, left, top: top + labelHeight });
  }

  await sharp({
    create: {
      width: sheetWidth,
      height: sheetHeight,
      channels: 4,
      background: "#111116",
    },
  })
    .composite(composites)
    .png()
    .toFile(join(REPORT_DIR, `contact-sheet-${viewport}.png`));
}

async function main() {
  await ensureDir(REPORT_DIR);
  const uiBase = await readUiBase();
  await verifyStaticStack(uiBase);
  const routes = await readRoutes();
  const browser = await chromium.launch();
  const records = [];
  try {
    for (const route of routes) {
      await verifyStaticStack(uiBase);
      records.push(await captureOne({ browser, uiBase, route }));
      await verifyStaticStack(uiBase);
    }
  } finally {
    await browser.close();
  }

  const summary = {
    total: records.length,
    readyFailures: records.filter((record) => !record.readyOk).length,
    errorScreens: records.filter((record) => record.inspection.bodyHasRedError)
      .length,
    overflow: records.filter((record) => record.inspection.hasHorizontalOverflow)
      .length,
    consoleIssues: records.flatMap((record) => record.issues).length,
  };
  const report = {
    runId: RUN_ID,
    uiBase,
    createdAt: new Date().toISOString(),
    routes: records,
    summary,
  };
  await writeFile(join(REPORT_DIR, "report.json"), JSON.stringify(report, null, 2));
  await makeContactSheet(records, "desktop");
  await makeContactSheet(records, "mobile");
  console.log(REPORT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
