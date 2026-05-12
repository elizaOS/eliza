import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const require = createRequire(import.meta.url);
const storybookBin = path.join(
  packageRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "storybook.cmd" : "storybook",
);
const playwrightPackage = require("@playwright/test");
const { chromium } = playwrightPackage;
const storybookHost = "127.0.0.1";
const storybookPort = Number.parseInt(
  process.env.STORYBOOK_PORT?.trim() || "6007",
  10,
);
const startupTimeoutMs = 120_000;
const storyLimit = Number.parseInt(
  process.env.STORYBOOK_E2E_STORY_LIMIT?.trim() || "3",
  10,
);
const baseUrl = `http://${storybookHost}:${storybookPort}`;

function fail(message) {
  throw new Error(`[storybook-e2e] ${message}`);
}

async function fetchStoryIndex() {
  const response = await fetch(`${baseUrl}/index.json`, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForStorybookReady() {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetchStoryIndex();
    } catch {
      await delay(500);
    }
  }
  fail(
    `storybook did not become ready at ${baseUrl} within ${startupTimeoutMs}ms`,
  );
}

function collectStoryIds(indexPayload) {
  const entries =
    indexPayload && typeof indexPayload === "object" && indexPayload.entries
      ? Object.entries(indexPayload.entries)
      : [];
  const storyIds = entries
    .filter(
      ([, entry]) =>
        entry && typeof entry === "object" && entry.type === "story",
    )
    .map(([storyId]) => storyId);

  if (storyIds.length === 0) {
    fail("no Storybook stories were discovered");
  }

  return storyIds.slice(0, Math.max(1, storyLimit));
}

async function waitForManagerUi(page) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#storybook-explorer-tree", { timeout: 15_000 });
}

async function verifyStory(browser, storyId) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  try {
    await page.goto(`${baseUrl}/iframe.html?id=${storyId}&viewMode=story`, {
      waitUntil: "networkidle",
    });
    await page.waitForFunction(() => {
      const root = document.querySelector("#storybook-root, #root");
      const bodyText = document.body.innerText || "";
      const bodyHtml = document.body.innerHTML || "";
      const hasKnownError =
        /failed to fetch dynamically imported module/i.test(bodyText) ||
        /storybook preview failed/i.test(bodyText) ||
        /error:/i.test(bodyText);

      return Boolean(root) && bodyHtml.trim().length > 0 && !hasKnownError;
    });

    if (pageErrors.length > 0) {
      fail(`${storyId} hit browser errors: ${pageErrors.join(" | ")}`);
    }
  } finally {
    await page.close();
  }
}

async function terminate(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null) {
      return;
    }
    await delay(250);
  }

  child.kill("SIGKILL");
}

const storybookProcess = spawn(
  storybookBin,
  [
    "dev",
    "-c",
    ".storybook-smoke",
    "--host",
    storybookHost,
    "--port",
    String(storybookPort),
    "--ci",
  ],
  {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CI: "1",
      STORYBOOK_DISABLE_TELEMETRY: "1",
    },
  },
);

try {
  const indexPayload = await waitForStorybookReady();
  const storyIds = collectStoryIds(indexPayload);
  const browser = await chromium.launch({
    headless: process.env.STORYBOOK_E2E_HEADLESS !== "0",
  });

  try {
    const managerPage = await browser.newPage();
    await waitForManagerUi(managerPage);
    await managerPage.close();

    for (const storyId of storyIds) {
      await verifyStory(browser, storyId);
    }
  } finally {
    await browser.close();
  }
} finally {
  await terminate(storybookProcess);
}
