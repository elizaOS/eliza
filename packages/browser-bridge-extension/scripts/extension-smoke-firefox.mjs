#!/usr/bin/env node
/**
 * Validates Firefox's deterministic XPI-ready artifacts, then installs the
 * unpacked extension into the real Firefox application over WebDriver BiDi and
 * proves authenticated manual pairing, tab sync, DOM action execution, and completion callbacks.
 */

import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import puppeteer from "puppeteer-core";
import { startMockAgentServer } from "./extension-smoke.mjs";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const firefoxDist = path.join(extensionRoot, "dist", "firefox");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");
const resultsDir = path.join(extensionRoot, "dist", "test-results");

function resolveFirefoxExecutable() {
  const configured = process.env.FIREFOX_EXECUTABLE_PATH?.trim();
  const candidates = [
    configured,
    process.platform === "darwin"
      ? "/Applications/Firefox.app/Contents/MacOS/firefox"
      : null,
    process.platform === "linux" ? "/usr/bin/firefox" : null,
    process.platform === "linux" ? "/usr/local/bin/firefox" : null,
    process.platform === "win32" && process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, "Mozilla Firefox", "firefox.exe")
      : null,
    process.platform === "win32" && process.env["PROGRAMFILES(X86)"]
      ? path.join(
          process.env["PROGRAMFILES(X86)"],
          "Mozilla Firefox",
          "firefox.exe",
        )
      : null,
  ].filter(
    (candidate) => typeof candidate === "string" && candidate.length > 0,
  );
  const executable = candidates.find((candidate) =>
    fsSync.existsSync(candidate),
  );
  if (!executable) {
    throw new Error(
      "Firefox is not installed in a standard location. Install Firefox or set FIREFOX_EXECUTABLE_PATH to the Firefox executable.",
    );
  }
  return executable;
}

async function waitForFirefoxAction(page, requests, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(
      () => document.querySelector("#smoke-action")?.dataset.clicked === "yes",
    );
    const completed = requests.some((request) =>
      request.path.endsWith("/session-smoke-test/complete"),
    );
    if (clicked && completed) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Firefox did not execute the DOM click and report session completion within 30 seconds.",
  );
}

async function saveFailureScreenshot(page) {
  await fs.mkdir(resultsDir, { recursive: true });
  try {
    await page.screenshot({
      path: path.join(resultsDir, "firefox-manual-pair-and-sync.png"),
      fullPage: true,
    });
  } catch (error) {
    // error-policy:J6 Failure capture must not replace the owning smoke error.
    console.warn(
      `Could not save Firefox smoke failure screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function waitForInstalledPairingGuide(browser, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      try {
        if (
          (await page.title()) === "Agent Browser Bridge" &&
          (await page.$("#pairingJson"))
        ) {
          return page;
        }
      } catch {
        // error-policy:J4 A page that disappears during discovery is simply
        // not the installed pairing guide; the timeout remains visible.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Firefox did not open the installed extension pairing guide within 20 seconds",
  );
}

async function runInstalledFirefoxSmoke() {
  const mockServer = await startMockAgentServer();
  let browser = null;
  let appPage = null;
  try {
    browser = await puppeteer.launch({
      browser: "firefox",
      executablePath: resolveFirefoxExecutable(),
      headless: true,
      protocol: "webDriverBiDi",
      timeout: 45_000,
    });
    const version = await browser.version();
    if (!version.toLowerCase().startsWith("firefox/")) {
      throw new Error(`Expected Firefox, but launched ${version}`);
    }
    appPage = (await browser.pages())[0] ?? (await browser.newPage());
    await appPage.goto(`${mockServer.origin}/chat`, {
      waitUntil: "domcontentloaded",
    });
    const extensionId = await browser.installExtension(firefoxDist);
    if (extensionId !== "browser-bridge@elizaos.ai") {
      throw new Error(
        `Firefox installed unexpected extension ID ${extensionId}`,
      );
    }
    // Firefox 153's BiDi implementation reports an extension-created tab as
    // about:blank even though its extension document is loaded. Identify the
    // installed guide by its real DOM rather than a stale protocol URL.
    const popupPage = await waitForInstalledPairingGuide(browser);
    await popupPage.click("#autoPair");
    const pairingJson = JSON.stringify({
      apiBaseUrl: mockServer.origin,
      companionId: "companion-smoke-test",
      pairingToken: "lobr_smoke_pairing_token",
      browser: "firefox",
      profileId: "default",
      profileLabel: "Default",
      label: "Agent Browser Bridge Firefox smoke",
    });
    await popupPage.$eval(
      "#pairingJson",
      (element, value) => {
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      },
      pairingJson,
    );
    await popupPage.click("#import");
    try {
      await popupPage.waitForFunction(
        () =>
          document
            .querySelector("#autoPair")
            ?.textContent?.includes("Sync This Browser"),
        { timeout: 20_000 },
      );
    } catch (error) {
      const popupState = await popupPage.evaluate(() => ({
        action: document.querySelector("#autoPair")?.textContent,
        detail: document.querySelector("#statusDetail")?.textContent,
        pairingJson: document.querySelector("#pairingJson")?.value,
        title: document.querySelector("#statusTitle")?.textContent,
      }));
      throw new Error(
        `Firefox pairing import did not settle: ${JSON.stringify(popupState)}`,
        { cause: error },
      );
    }
    await popupPage.close();
    await waitForFirefoxAction(appPage, mockServer.requests);

    const autoPair = mockServer.requests.find(
      (request) => request.path === "/api/browser-bridge/companions/auto-pair",
    );
    const preflight = mockServer.requests.find(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/browser-bridge/companions/preflight",
    );
    const sync = mockServer.requests.find(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/browser-bridge/companions/sync",
    );
    const progress = mockServer.requests.find(
      (request) =>
        request.path.endsWith("/session-smoke-test/progress") &&
        request.body?.completedActionId === "action-smoke-click" &&
        request.body?.result?.["action-smoke-click"]?.tagName === "button",
    );
    const begin = mockServer.requests.find((request) =>
      request.path.endsWith("/session-smoke-test/actions/begin"),
    );
    const complete = mockServer.requests.find((request) =>
      request.path.endsWith("/session-smoke-test/complete"),
    );
    if (
      autoPair ||
      !preflight ||
      sync?.body?.settingsVersion !== "settings-smoke-v1" ||
      sync?.authorization !== "Bearer lobr_smoke_pairing_token" ||
      sync?.companionId !== "companion-smoke-test" ||
      !begin ||
      !progress ||
      begin.body?.attemptId !== progress.body?.attemptId ||
      !complete
    ) {
      throw new Error(
        "Firefox smoke did not observe imported-auth preflight, version-bound sync, action progress, and completion without auto-pair.",
      );
    }
    return version;
  } catch (error) {
    if (appPage) {
      await saveFailureScreenshot(appPage);
    }
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        // error-policy:J6 Browser teardown must not hide the smoke result.
        console.warn(
          `Could not close Firefox after smoke: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await mockServer.close();
  }
}

await run("bun", [path.join(scriptDir, "package-firefox.mjs")], {
  cwd: extensionRoot,
});

const manifest = JSON.parse(
  await fs.readFile(path.join(firefoxDist, "manifest.json"), "utf8"),
);
if (manifest.manifest_version !== 3) {
  throw new Error("Firefox manifest must use Manifest V3");
}
if (manifest.background?.scripts?.[0] !== "background.js") {
  throw new Error(
    "Firefox manifest must use a persistent WebExtension background script declaration",
  );
}
if (manifest.background?.service_worker) {
  throw new Error(
    "Firefox build must not depend on Chromium service_worker semantics",
  );
}
if (
  manifest.browser_specific_settings?.gecko?.id !== "browser-bridge@elizaos.ai"
) {
  throw new Error("Firefox manifest is missing the stable Gecko extension ID");
}
if (
  manifest.optional_host_permissions?.join(",") !== "https://*/*,http://*/*"
) {
  throw new Error("Firefox optional host permissions drifted");
}
if (manifest.content_security_policy?.extension_pages.includes("unsafe-eval")) {
  throw new Error("Firefox extension CSP must not permit eval");
}

const zipPath = path.join(artifactsDir, "browser-bridge-firefox.zip");
const xpiPath = path.join(artifactsDir, "browser-bridge-firefox.xpi");
const [zipBytes, xpiBytes] = await Promise.all([
  fs.readFile(zipPath),
  fs.readFile(xpiPath),
]);
if (!zipBytes.equals(xpiBytes)) {
  throw new Error("Firefox ZIP and XPI-ready artifacts must be byte-identical");
}
const entries = unzipSync(new Uint8Array(zipBytes));
if (!entries["manifest.json"] || !entries["background.js"]) {
  throw new Error(
    "Firefox archive must contain manifest.json and background.js at its root",
  );
}
if (entries["firefox/manifest.json"]) {
  throw new Error(
    "Firefox archive must not nest the extension under a firefox directory",
  );
}
const firstHash = createHash("sha256").update(zipBytes).digest("hex");
await run("bun", [path.join(scriptDir, "package-firefox.mjs")], {
  cwd: extensionRoot,
});
const secondHash = createHash("sha256")
  .update(await fs.readFile(zipPath))
  .digest("hex");
if (firstHash !== secondHash) {
  throw new Error("Firefox package is not byte-reproducible");
}
const firefoxVersion = await runInstalledFirefoxSmoke();
console.log(
  `Firefox extension smoke passed (${firefoxVersion}, sha256 ${secondHash})`,
);
