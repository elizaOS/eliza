#!/usr/bin/env node
/**
 * Installed Chrome for Testing smoke: verifies the dist/chrome artifacts and
 * exercises optional website access, pairing, sync, a real DOM click, and a
 * website-block redirect against a deterministic local agent HTTP harness.
 * The browser, extension, page, and transport are real; only the agent business
 * service is isolated. Branded Chrome 137+ rejects command-line extension loads.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(extensionRoot, "..", "..");
const chromeDistDir = path.join(extensionRoot, "dist", "chrome");
const resultsDir = path.join(extensionRoot, "dist", "test-results");
const exerciseSiteAccess = process.env.BROWSER_BRIDGE_SMOKE_SITE_ACCESS === "1";
const removePathRecursiveScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

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
    path.join(repoRoot, "node_modules", "@playwright", "test", "index.mjs"),
    path.join(
      repoRoot,
      "packages",
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

function resolveChromeForTestingExecutable() {
  const configured = process.env.CHROME_FOR_TESTING_EXECUTABLE_PATH?.trim();
  const candidates = [
    configured,
    process.platform === "darwin"
      ? "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      : undefined,
  ].filter((candidate) => typeof candidate === "string");
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(
      "Chrome for Testing is required because branded Chrome 137+ disables --load-extension. Set CHROME_FOR_TESTING_EXECUTABLE_PATH to an installed official Chrome for Testing executable.",
    );
  }
  return executable;
}

async function removePathRecursive(targetPath) {
  await run(process.execPath, [removePathRecursiveScript, targetPath], {
    cwd: repoRoot,
  });
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
      executablePath: resolveChromeForTestingExecutable(),
      headless:
        process.env.BROWSER_BRIDGE_SMOKE_HEADLESS === "1" ||
        !exerciseSiteAccess,
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
        await removePathRecursive(userDataDir);
      },
    };
  } catch (error) {
    // error-policy:J2 Preserve the launch failure after removing its isolated
    // temporary profile.
    await removePathRecursive(userDataDir);
    throw error;
  }
}

async function saveScreenshot(page, name) {
  await fsp.mkdir(resultsDir, { recursive: true });
  const screenshotPath = path.join(resultsDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

async function saveFailureScreenshot(page, name) {
  try {
    await saveScreenshot(page, name);
  } catch (error) {
    // error-policy:J6 Failure capture must not replace the owning smoke error.
    console.warn(
      `Could not save Chrome smoke failure screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

async function waitForPopupSettled(page) {
  await page.waitForFunction(() => {
    const title = document.querySelector("#statusTitle")?.textContent ?? "";
    const primary = document.querySelector("#primaryAction");
    return (
      title.trim().length > 0 &&
      title !== "Connecting to Eliza…" &&
      (!(primary instanceof HTMLButtonElement) ||
        primary.hidden ||
        !primary.disabled)
    );
  });
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
  const browser = ["chrome", "firefox", "safari"].includes(requestBody?.browser)
    ? requestBody.browser
    : "chrome";
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

export async function startMockAgentServer() {
  const requests = [];
  let sessionCompleted = false;
  let activeSession = null;
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
      authorization: req.headers.authorization ?? null,
      companionId: req.headers["x-browser-bridge-companion-id"] ?? null,
    });
    if (process.env.BROWSER_BRIDGE_SMOKE_LOG_REQUESTS === "1") {
      console.log(`${req.method ?? "GET"} ${url.pathname}`);
    }

    if (url.pathname === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><title>Eliza</title></head><body><h1>Eliza</h1><p>Mock app page for extension smoke tests.</p><button id="smoke-action" onclick="this.dataset.clicked=\'yes\'">Run smoke action</button></body></html>',
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
      res.writeHead(410, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Automatic browser pairing is disabled. Import pairing JSON.",
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/browser-bridge/companions/preflight"
    ) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const companion = createMockCompanion(origin, jsonBody?.companion);
      const responsePayload = {
        companion,
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
        settingsVersion: "settings-smoke-v1",
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname ===
        "/api/browser-bridge/companions/sessions/session-smoke-test/actions/begin"
    ) {
      if (
        !activeSession ||
        jsonBody?.currentActionIndex !== activeSession.currentActionIndex ||
        jsonBody?.actionId !==
          activeSession.actions[activeSession.currentActionIndex]?.id ||
        typeof jsonBody?.attemptId !== "string" ||
        !jsonBody.attemptId
      ) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Action checkpoint mismatch" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ session: activeSession }));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/browser-bridge/companions/sync"
    ) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const companion = createMockCompanion(origin, jsonBody?.companion);
      const firstTab = Array.isArray(jsonBody?.tabs) ? jsonBody.tabs[0] : null;
      const responsePayload = {
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
        settingsVersion: "settings-smoke-v1",
        session:
          firstTab && !sessionCompleted
            ? {
                id: "session-smoke-test",
                agentId: companion.agentId,
                domain: "browser",
                subjectType: "smoke",
                subjectId: "smoke",
                visibilityScope: "private",
                contextPolicy: "private",
                workflowId: null,
                browser: companion.browser,
                companionId: companion.id,
                profileId: companion.profileId,
                windowId: firstTab.windowId,
                tabId: firstTab.tabId,
                title: "Chrome action smoke",
                status: "running",
                actions: [
                  {
                    id: "action-smoke-click",
                    kind: "click",
                    label: "Click the smoke button",
                    browser: companion.browser,
                    windowId: firstTab.windowId,
                    tabId: firstTab.tabId,
                    url: firstTab.url,
                    selector: "#smoke-action",
                    text: null,
                    accountAffecting: false,
                    requiresConfirmation: false,
                    metadata: {},
                  },
                ],
                currentActionIndex: 0,
                awaitingConfirmationForActionId: null,
                result: {},
                metadata: {},
                createdAt: nowIso(),
                updatedAt: nowIso(),
                finishedAt: null,
              }
            : null,
      };
      activeSession = responsePayload.session;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responsePayload));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname ===
        "/api/browser-bridge/companions/sessions/session-smoke-test/progress"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname ===
        "/api/browser-bridge/companions/sessions/session-smoke-test/complete"
    ) {
      sessionCompleted = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/website-blocker") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          exerciseSiteAccess && url.searchParams.get("host")
            ? {
                active: true,
                blocked: true,
                host: url.searchParams.get("host"),
                groupKey: "smoke",
                requiredTasks: [
                  {
                    id: "task-smoke",
                    title: "Complete the installed-browser smoke task",
                    completed: false,
                  },
                ],
                websites: ["localhost"],
              }
            : exerciseSiteAccess
              ? {
                  active: true,
                  blockedWebsites: ["localhost"],
                  allowedWebsites: [],
                }
              : { active: false, blockedWebsites: [], allowedWebsites: [] },
        ),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const configuredPort = Number.parseInt(
    process.env.BROWSER_BRIDGE_SMOKE_PORT ?? "0",
    10,
  );
  if (!Number.isInteger(configuredPort) || configuredPort < 0) {
    throw new Error(
      "BROWSER_BRIDGE_SMOKE_PORT must be a non-negative integer.",
    );
  }
  await new Promise((resolve) => {
    server.listen(configuredPort, "127.0.0.1", resolve);
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
    await waitForPopupSettled(popupPage);
  } catch (error) {
    await saveFailureScreenshot(popupPage, "popup-boot-failure");
    throw error;
  } finally {
    await session.close();
  }
}

async function runPairAndSyncScenario(chromium) {
  const mockServer = await startMockAgentServer();
  const session = await launchExtensionContext(chromium);
  const appPage = await session.context.newPage();
  await appPage.goto(`${mockServer.origin}/chat`);
  await appPage.waitForLoadState("domcontentloaded");
  const popupPage = await openPopup(session.context, session.extensionId);

  try {
    await waitForPopupSettled(popupPage);
    await popupPage.evaluate(
      async (config) => {
        const saved = await chrome.runtime.sendMessage({
          type: "browser-bridge:save-config",
          config,
        });
        if (!saved?.ok) {
          throw new Error(saved?.error ?? "pairing setup failed");
        }
        const synced = await chrome.runtime.sendMessage({
          type: "browser-bridge:sync-now",
        });
        if (!synced?.ok) {
          throw new Error(synced?.error ?? "pairing sync failed");
        }
      },
      {
        apiBaseUrl: mockServer.origin,
        companionId: "companion-smoke-test",
        pairingToken: "lobr_smoke_pairing_token",
        browser: "chrome",
        profileId: "default",
        profileLabel: "Default",
        label: "Agent Browser Bridge smoke",
      },
    );
    await popupPage.reload();
    await waitForPopupSettled(popupPage);
    const setupState = await popupPage.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "browser-bridge:get-state" }),
    );
    if (setupState?.state?.lastError && !setupState.state.settings) {
      throw new Error(
        `Browser pairing setup failed: ${setupState.state.lastError}`,
      );
    }
    await waitForPopupText(popupPage, "#statusTitle", "Connected", 20_000);
    if (exerciseSiteAccess) {
      await waitForPopupText(
        popupPage,
        "#primaryAction",
        "Grant website access",
        20_000,
      );
      await popupPage.click("#primaryAction");
      await waitForPopupText(
        popupPage,
        "#statusTitle",
        "Connected to Eliza",
        120_000,
      );
      await saveScreenshot(popupPage, "chrome-website-access-granted");
    }
    const compactPopup = await popupPage.evaluate(
      (apiOrigin) => ({
        hasDiagnostics: document.querySelector("dl") !== null,
        exposesApiOrigin:
          document.body.textContent?.includes(apiOrigin) ?? false,
      }),
      mockServer.origin,
    );
    if (compactPopup.hasDiagnostics || compactPopup.exposesApiOrigin) {
      throw new Error("Chrome popup exposed removed connection diagnostics.");
    }
    await saveScreenshot(popupPage, "chrome-pair-and-sync-success");

    const syncRequests = mockServer.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/browser-bridge/companions/sync",
    );
    if (
      mockServer.requests.some(
        (request) =>
          request.path === "/api/browser-bridge/companions/auto-pair",
      )
    ) {
      throw new Error("Chrome smoke observed a forbidden auto-pair request.");
    }
    if (
      syncRequests.some(
        (request) =>
          request.authorization !== "Bearer lobr_smoke_pairing_token" ||
          request.companionId !== "companion-smoke-test",
      )
    ) {
      throw new Error(
        "Chrome smoke sync did not use imported pairing credentials.",
      );
    }
    const preflightRequests = mockServer.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/browser-bridge/companions/preflight",
    );
    if (preflightRequests.length === 0) {
      throw new Error(
        "Expected the smoke test to preflight companion settings before sync.",
      );
    }
    if (syncRequests.length === 0) {
      throw new Error(
        "Expected the smoke test to hit the companion sync route at least once.",
      );
    }
    if (
      syncRequests.some(
        (request) => request.body?.settingsVersion !== "settings-smoke-v1",
      )
    ) {
      throw new Error(
        "Expected every smoke sync request to bind the preflight settings version.",
      );
    }
    await appPage.waitForFunction(
      () => document.querySelector("#smoke-action")?.dataset.clicked === "yes",
      undefined,
      { timeout: 20_000 },
    );
    await appPage.waitForTimeout(250);
    const progressRequest = mockServer.requests.find(
      (request) =>
        request.path.endsWith("/session-smoke-test/progress") &&
        request.body?.result?.["action-smoke-click"]?.tagName === "button",
    );
    const beginRequest = mockServer.requests.find((request) =>
      request.path.endsWith("/session-smoke-test/actions/begin"),
    );
    const completionRequest = mockServer.requests.find((request) =>
      request.path.endsWith("/session-smoke-test/complete"),
    );
    if (
      !beginRequest ||
      !progressRequest ||
      beginRequest.body?.attemptId !== progressRequest.body?.attemptId ||
      !completionRequest
    ) {
      throw new Error(
        "Expected an action lease, matching attempt-bound DOM result, and session completion callback.",
      );
    }

    if (exerciseSiteAccess) {
      const blockedTarget = `${mockServer.origin.replace("127.0.0.1", "localhost")}/blocked-target`;
      try {
        await appPage.goto(blockedTarget);
      } catch (error) {
        // error-policy:J4 Chromium may surface the DNR interception as
        // ERR_BLOCKED_BY_CLIENT even while committing the extension redirect.
        // Only that exact browser-owned signal is expected here.
        if (
          !(error instanceof Error) ||
          !error.message.includes("ERR_BLOCKED_BY_CLIENT")
        ) {
          throw error;
        }
      }
      await appPage.waitForURL(
        (url) =>
          url.protocol === "chrome-extension:" &&
          url.pathname.endsWith("/blocked.html"),
        { timeout: 20_000 },
      );
      await waitForPopupText(
        appPage,
        "#taskList",
        "Complete the installed-browser smoke task",
        20_000,
      );
      const redirectedUrl = new URL(appPage.url());
      if (
        redirectedUrl.searchParams.get("api") !== mockServer.origin ||
        redirectedUrl.searchParams.get("host") !== "localhost"
      ) {
        throw new Error(
          `Blocked-page redirect did not bind to the paired agent and blocked host: ${redirectedUrl}`,
        );
      }
      await saveScreenshot(appPage, "chrome-blocked-page-success");
    }
  } catch (error) {
    await saveFailureScreenshot(popupPage, "pair-and-sync-failure");
    throw error;
  } finally {
    try {
      await popupPage.close();
      await appPage.close();
    } catch (error) {
      // error-policy:J6 Page teardown must not hide the smoke result.
      console.warn(
        `Could not close Chrome smoke pages: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await session.close();
    await mockServer.close();
  }
}

async function main() {
  await ensureChromeBuild();
  const { chromium } = await loadPlaywright();
  await runPopupBootScenario(chromium);
  await runPairAndSyncScenario(chromium);
  console.log("Agent Browser Bridge extension smoke checks passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--server-only")) {
    const mockServer = await startMockAgentServer();
    console.log(
      `Browser bridge smoke server listening at ${mockServer.origin}`,
    );
    await new Promise(() => {});
  } else {
    await main();
  }
}
