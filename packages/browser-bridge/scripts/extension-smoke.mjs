#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(extensionRoot, "..", "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const chromeDistDir = path.join(extensionRoot, "dist", "chrome");
const resultsDir = path.join(extensionRoot, "dist", "test-results");

function resolveBunCommand() {
  const bunFromEnv = process.env.BUN?.trim();
  if (bunFromEnv && fs.existsSync(bunFromEnv)) {
    return bunFromEnv;
  }
  if (
    typeof process.versions.bun === "string" &&
    typeof process.execPath === "string" &&
    process.execPath.length > 0 &&
    fs.existsSync(process.execPath)
  ) {
    return process.execPath;
  }
  const homeBun = path.join(
    os.homedir(),
    ".bun",
    "bin",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  if (fs.existsSync(homeBun)) {
    return homeBun;
  }
  return process.platform === "win32" ? "bun.exe" : "bun";
}

function resolvePlaywrightModulePath() {
  const candidates = [
    path.join(
      workspaceRoot,
      "apps",
      "app",
      "node_modules",
      "@playwright",
      "test",
      "index.mjs",
    ),
    path.join(
      workspaceRoot,
      "node_modules",
      "@playwright",
      "test",
      "index.mjs",
    ),
    path.join(repoRoot, "node_modules", "@playwright", "test", "index.mjs"),
    path.join(
      repoRoot,
      "apps",
      "app",
      "node_modules",
      "@playwright",
      "test",
      "index.mjs",
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Could not resolve @playwright/test. Install app dependencies before running Agent Browser Bridge smoke tests.",
  );
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

async function ensureChromeBuild() {
  await run(
    resolveBunCommand(),
    [path.join(scriptDir, "build.mjs"), "chrome"],
    {
      cwd: extensionRoot,
    },
  );
}

async function loadPlaywright() {
  const modulePath = resolvePlaywrightModulePath();
  const playwright = await import(pathToFileURL(modulePath).href);
  if (!playwright.chromium) {
    throw new Error("Resolved @playwright/test but chromium is unavailable");
  }
  return playwright;
}

async function createTempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitForServiceWorker(context) {
  return (
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"))
  );
}

async function launchExtensionContext(chromium) {
  const userDataDir = await createTempDir("browser-bridge-smoke-");
  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${chromeDistDir}`,
        `--load-extension=${chromeDistDir}`,
      ],
    });
    const serviceWorker = await waitForServiceWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    return {
      context,
      extensionId,
      async close() {
        await context.close();
        await fsp.rm(userDataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fsp.rm(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

async function saveFailureScreenshot(page, name) {
  await fsp.mkdir(resultsDir, { recursive: true });
  const screenshotPath = path.join(resultsDir, `${name}.png`);
  await page
    .screenshot({ path: screenshotPath, fullPage: true })
    .catch(() => {});
}

async function openPopup(context, extensionId) {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.waitForLoadState("domcontentloaded");
  return popupPage;
}

async function waitForPopupText(page, selector, expected, timeout = 20_000) {
  await page.waitForFunction(
    ([query, value]) => {
      const element = document.querySelector(query);
      return Boolean(element?.textContent?.includes(value));
    },
    [selector, expected],
    {
      timeout,
    },
  );
}

async function readText(page, selector) {
  return (await page.locator(selector).textContent()) ?? "";
}

function nowIso() {
  return new Date().toISOString();
}

function createMockCompanion(origin, requestBody) {
  const profileId =
    typeof requestBody?.profileId === "string" && requestBody.profileId.trim()
      ? requestBody.profileId
      : "default";
  const profileLabel =
    typeof requestBody?.profileLabel === "string" &&
    requestBody.profileLabel.trim()
      ? requestBody.profileLabel
      : "Default";
  const browser = requestBody?.browser === "safari" ? "safari" : "chrome";
  return {
    id: "companion-smoke-test",
    agentId: "agent-smoke-test",
    browser,
    profileId,
    profileLabel,
    label: "Agent Browser Bridge smoke",
    extensionVersion: "0.1.0",
    connectionState: "connected",
    permissions: {
      tabs: true,
      scripting: true,
      activeTab: true,
      allOrigins: true,
      grantedOrigins: ["<all_urls>"],
      incognitoEnabled: false,
    },
    lastSeenAt: nowIso(),
    pairedAt: nowIso(),
    metadata: {
      smokeTest: true,
      origin,
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

async function startMockAgentServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
    }
    const jsonBody = body.trim() ? JSON.parse(body) : null;
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      body: jsonBody,
    });

    if (url.pathname === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>Eliza</title></head><body><h1>Eliza</h1><p>Mock app page for extension smoke tests.</p></body></html>",
      );
      return;
    }

    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ state: "running" }));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/browser-bridge/companions/auto-pair"
    ) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const companion = createMockCompanion(origin, jsonBody);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          companion,
          config: {
            apiBaseUrl: origin,
            companionId: companion.id,
            pairingToken: "lobr_smoke_pairing_token",
            browser: companion.browser,
            profileId: companion.profileId,
            profileLabel: companion.profileLabel,
            label: companion.label,
          },
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/browser-bridge/companions/sync"
    ) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const companion = createMockCompanion(origin, jsonBody?.companion);
      const firstTab = Array.isArray(jsonBody?.tabs) ? jsonBody.tabs[0] : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          companion,
          tabs: Array.isArray(jsonBody?.tabs)
            ? jsonBody.tabs.map((tab, index) => ({
                id: `tab-${index + 1}`,
                agentId: companion.agentId,
                companionId: companion.id,
                browser: companion.browser,
                profileId: tab.profileId,
                windowId: tab.windowId,
                tabId: tab.tabId,
                url: tab.url,
                title: tab.title,
                activeInWindow: tab.activeInWindow,
                focusedWindow: tab.focusedWindow,
                focusedActive: tab.focusedActive,
                incognito: Boolean(tab.incognito),
                faviconUrl: tab.faviconUrl ?? null,
                lastSeenAt: tab.lastSeenAt ?? nowIso(),
                lastFocusedAt: tab.lastFocusedAt ?? null,
                metadata: tab.metadata ?? {},
                createdAt: nowIso(),
                updatedAt: nowIso(),
              }))
            : [],
          currentPage: firstTab
            ? {
                id: "page-smoke-test",
                agentId: companion.agentId,
                browser: companion.browser,
                profileId: firstTab.profileId,
                windowId: firstTab.windowId,
                tabId: firstTab.tabId,
                url: firstTab.url,
                title: firstTab.title,
                selectionText: null,
                mainText: "Mock agent page",
                headings: ["Eliza"],
                links: [],
                forms: [],
                capturedAt: nowIso(),
                metadata: {},
              }
            : null,
          settings: {
            enabled: true,
            trackingMode: "active_tabs",
            allowBrowserControl: true,
            requireConfirmationForAccountAffecting: true,
            incognitoEnabled: false,
            siteAccessMode: "all_sites",
            grantedOrigins: [],
            blockedOrigins: [],
            maxRememberedTabs: 10,
            pauseUntil: null,
            metadata: {},
            updatedAt: nowIso(),
          },
          session: null,
        }),
      );
      return;
    }

    if (url.pathname === "/api/website-blocker") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: false, websites: [] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function runPopupBootScenario(chromium) {
  const session = await launchExtensionContext(chromium);
  const popupPage = await openPopup(session.context, session.extensionId);
  try {
    await popupPage.waitForFunction(() => {
      const title = document.querySelector("#statusTitle")?.textContent ?? "";
      const badge = document.querySelector("#statusBadge")?.textContent ?? "";
      const primary =
        document.querySelector("#autoPair")?.textContent?.trim() ?? "";
      return (
        title.trim().length > 0 &&
        title !== "Loading extension state…" &&
        badge !== "Loading" &&
        primary.length > 0
      );
    });
  } catch (error) {
    await saveFailureScreenshot(popupPage, "popup-boot");
    throw error;
  } finally {
    await session.close();
  }
}

async function runAutoPairAndSyncScenario(chromium) {
  const mockServer = await startMockAgentServer();
  const session = await launchExtensionContext(chromium);
  const appPage = await session.context.newPage();
  await appPage.goto(`${mockServer.origin}/chat`);
  await appPage.waitForLoadState("domcontentloaded");
  const popupPage = await openPopup(session.context, session.extensionId);

  try {
    await popupPage.waitForFunction(() => {
      const button = document.querySelector("#autoPair");
      return Boolean(
        button?.textContent?.includes("Auto Connect") ||
          button?.textContent?.includes("Sync This Browser"),
      );
    });

    const firstLabel = await readText(popupPage, "#autoPair");
    if (!firstLabel.includes("Sync This Browser")) {
      await popupPage.click("#autoPair");
      await waitForPopupText(
        popupPage,
        "#autoPair",
        "Sync This Browser",
        20_000,
      );
    }

    await popupPage.click("#autoPair");
    await waitForPopupText(
      popupPage,
      "#statusTitle",
      "This browser is connected to Eliza",
      20_000,
    );
    await waitForPopupText(
      popupPage,
      "#summary",
      `App: ${mockServer.origin}`,
      10_000,
    );

    const syncRequests = mockServer.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/browser-bridge/companions/sync",
    );
    if (syncRequests.length === 0) {
      throw new Error(
        "Expected the smoke test to hit the companion sync route at least once.",
      );
    }
  } catch (error) {
    await saveFailureScreenshot(popupPage, "auto-pair-and-sync");
    throw error;
  } finally {
    await popupPage.close().catch(() => {});
    await appPage.close().catch(() => {});
    await session.close();
    await mockServer.close();
  }
}

async function main() {
  await ensureChromeBuild();
  const { chromium } = await loadPlaywright();
  try {
    await runPopupBootScenario(chromium);
    await runAutoPairAndSyncScenario(chromium);
  } catch (error) {
    if (
      error instanceof Error &&
      /Executable doesn't exist|browserType\.launchPersistentContext/i.test(
        error.message,
      )
    ) {
      throw new Error(
        `Playwright Chromium is not installed. Run "cd ${path.join(repoRoot, "apps", "app")} && bunx playwright install chromium" and rerun the smoke test.\n\n${error.message}`,
      );
    }
    throw error;
  }
  console.log("Agent Browser Bridge extension smoke checks passed.");
}

await main();
