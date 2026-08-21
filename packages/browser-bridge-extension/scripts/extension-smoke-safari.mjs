#!/usr/bin/env node
/**
 * Installed-Safari smoke: creates a development-signed container app, verifies
 * that Safari registers its extension while unsigned extensions remain off,
 * and exercises pairing/sync through the real installed popup. The plist and
 * UI checks require a real macOS/Safari host and a local Apple Development
 * signing identity.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const signedSafariAppPath = path.join(
  extensionRoot,
  "dist",
  "artifacts",
  "Agent Browser Bridge.app",
);
const safariExtensionsPlist = path.join(
  os.homedir(),
  "Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist",
);
const safariDeveloperWindowName = "Developer";
const safariExtensionsWindowName = "Extensions";
const safariAppName = "Safari";
const safariAppDisplayName = "Agent Browser Bridge";
const safariBundleIdentifierPrefix = "ai.elizaos.browserbridge";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? null;
    const child = spawn(command, args, {
      stdio: "pipe",
      ...options,
    });
    let stdout = "";
    let stderr = "";
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGTERM");
            reject(
              new Error(
                `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs)
        : null;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}\n${stderr}`,
        ),
      );
    });
  });
}

function assertMacOs() {
  if (process.platform !== "darwin") {
    throw new Error(
      "Safari smoke tests only run on macOS because they depend on Safari, safaridriver, and AppleScript UI scripting.",
    );
  }
}

async function runAppleScript(source, options = {}) {
  const { stdout } = await run("osascript", ["-e", source], {
    cwd: extensionRoot,
    timeoutMs: options.timeoutMs ?? 20_000,
  });
  return stdout.trim();
}

async function resolveSafariSigningIdentity() {
  const { stdout } = await run(
    "security",
    ["find-identity", "-v", "-p", "codesigning"],
    { cwd: extensionRoot },
  );
  const match = stdout.match(
    /^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development:.*\(([A-Z0-9]{10})\)"/m,
  );
  if (!match) {
    throw new Error(
      "Installed Safari smoke requires an Apple Development signing identity in the login keychain.",
    );
  }
  return { identity: match[1], team: match[2] };
}

async function buildSignedSafariWebExtension() {
  const signing = await resolveSafariSigningIdentity();
  await run("bun", [path.join(scriptDir, "package-safari.mjs")], {
    cwd: extensionRoot,
    env: {
      ...process.env,
      ELIZA_SAFARI_SIGNING_IDENTITY: signing.identity,
      ELIZA_SAFARI_SIGNING_TEAM: signing.team,
    },
    timeoutMs: 180_000,
  });
}

async function ensureSafariDevelopMenu() {
  const present = await runAppleScript(`
    tell application "${safariAppName}" to activate
    tell application "System Events"
      tell process "${safariAppName}"
        return exists menu "Develop" of menu bar 1
      end tell
    end tell
  `);
  if (present !== "true") {
    throw new Error(
      "Safari's Develop menu is disabled. Enable it manually before running installed Safari acceptance.",
    );
  }
}

async function openSafariDeveloperSettings() {
  await runAppleScript(`
    tell application "${safariAppName}" to activate
    delay 1
    tell application "System Events"
      tell process "${safariAppName}"
        set frontmost to true
        if not (exists window "${safariDeveloperWindowName}") then
          click menu item "Developer Settings…" of menu "Develop" of menu bar 1
          delay 1
        end if
      end tell
    end tell
  `);
}

async function readSafariDeveloperFlags() {
  const raw = await runAppleScript(`
    tell application "System Events"
      tell process "${safariAppName}"
        tell window "${safariDeveloperWindowName}"
          tell group 1 of group 1
            set remoteAutomation to value of checkbox "Allow remote automation"
            set unsignedExtensions to value of checkbox "Allow unsigned extensions"
            set jsFromAppleEvents to value of checkbox "Allow JavaScript from Apple Events"
          end tell
          set authPromptVisible to exists sheet 1
          return (remoteAutomation as string) & "," & (unsignedExtensions as string) & "," & (jsFromAppleEvents as string) & "," & (authPromptVisible as string)
        end tell
      end tell
    end tell
  `);
  const [
    remoteAutomation,
    unsignedExtensions,
    jsFromAppleEvents,
    authPromptVisible,
  ] = raw.split(",");
  return {
    remoteAutomation: remoteAutomation === "1",
    unsignedExtensions: unsignedExtensions === "1",
    jsFromAppleEvents: jsFromAppleEvents === "1",
    authPromptVisible: authPromptVisible === "true",
  };
}

async function ensureSafariDeveloperPrerequisites() {
  await openSafariDeveloperSettings();
  const flags = await readSafariDeveloperFlags();
  if (!flags.remoteAutomation) {
    throw new Error(
      'Safari remote automation is disabled. Enable "Allow remote automation" manually before running installed Safari acceptance.',
    );
  }
  if (!flags.jsFromAppleEvents) {
    throw new Error(
      'Safari has "Allow JavaScript from Apple Events" turned off. Enable it manually before running installed Safari acceptance.',
    );
  }
  if (flags.unsignedExtensions || flags.authPromptVisible) {
    throw new Error(
      'Installed Safari acceptance requires "Allow unsigned extensions" to remain OFF and no authentication sheet to be pending.',
    );
  }
}

export function parseSafariWebExtensionsPlist(stdout) {
  const entries = new Map();
  let currentEntry = null;
  for (const line of stdout.split("\n")) {
    const entryMatch = line.match(/^ {2}"([^"]+)" => \{$/);
    if (entryMatch) {
      currentEntry = entryMatch[1];
      entries.set(currentEntry, { removed: false });
      continue;
    }
    if (currentEntry && /^ {4}"RemovedDate" => /.test(line)) {
      entries.get(currentEntry).removed = true;
    }
  }
  return entries;
}

async function readSafariWebExtensionsPlist() {
  try {
    const { stdout } = await run("plutil", ["-p", safariExtensionsPlist], {
      cwd: extensionRoot,
    });
    return parseSafariWebExtensionsPlist(stdout);
  } catch {
    return new Map();
  }
}

export function normalizeSafariExtensionKey(key) {
  return key.replace(/\s+\([^)]*\)$/, "").trim();
}

export function browserBridgeSafariPopupCandidates(extensionKeys) {
  const baseIds = extensionKeys.map(normalizeSafariExtensionKey);
  return [
    ...new Set(
      baseIds.flatMap((baseId) => [
        `safari-web-extension://${baseId}/popup.html`,
        `safari-web-extension://${baseId}/dist/safari/popup.html`,
      ]),
    ),
  ];
}

async function installSignedSafariExtension() {
  await run("open", ["-n", signedSafariAppPath], {
    cwd: extensionRoot,
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const installed = await readSafariWebExtensionsPlist();
  return [...installed]
    .flatMap(([key, state]) =>
      !state.removed &&
      (/browserbridge/i.test(key) ||
        key.startsWith(safariBundleIdentifierPrefix))
        ? [key]
        : [],
    )
    .filter(
      (key) =>
        /browserbridge/i.test(key) ||
        key.startsWith(safariBundleIdentifierPrefix),
    );
}

async function openSafariExtensionsPreferences() {
  await runAppleScript(`
    tell application "${safariAppName}" to activate
    delay 1
    tell application "System Events"
      tell process "${safariAppName}"
        set frontmost to true
        click menu item "Settings…" of menu "Safari" of menu bar 1
        delay 1
        click button "Extensions" of toolbar 1 of window 1
        delay 1
      end tell
    end tell
  `);
}

async function enableBrowserBridgeExtensionInSafari() {
  await openSafariExtensionsPreferences();
  const rowName = await runAppleScript(`
    tell application "System Events"
      tell process "${safariAppName}"
        tell window "${safariExtensionsWindowName}"
          tell table 1 of scroll area 1 of group 2 of group 1 of group 1
            repeat with currentRow in rows
              try
                set rowElement to UI element 1 of currentRow
                set rowLabel to name of rowElement
                if rowLabel contains "Agent Browser Bridge" then
                  if value of checkbox 1 of rowElement is 0 then click checkbox 1 of rowElement
                  return rowLabel
                end if
              end try
            end repeat
          end tell
        end tell
      end tell
    end tell
  `);
  if (!rowName) {
    throw new Error(
      "Safari did not show an Agent Browser Bridge extension row after launching the signed container app.",
    );
  }
  return rowName;
}

async function openSafariUrl(url, inNewTab = false) {
  const escapedUrl = url.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await runAppleScript(`
    tell application "${safariAppName}"
      activate
      if not (exists front window) then
        make new document
      end if
      tell front window
        if ${inNewTab ? "true" : "false"} then
          set current tab to (make new tab with properties {URL:"${escapedUrl}"})
        else
          set URL of current tab to "${escapedUrl}"
        end if
      end tell
    end tell
  `);
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function readSafariFrontTabState() {
  const raw = await runAppleScript(`
    tell application "${safariAppName}"
      set payload to do JavaScript "JSON.stringify({ title: document.querySelector('#statusTitle')?.textContent ?? document.title ?? '', button: document.querySelector('#primaryAction')?.textContent ?? '', app: document.querySelector('#appValue')?.textContent ?? '' })" in current tab of front window
      return payload
    end tell
  `);
  return JSON.parse(raw || "{}");
}

async function clickSafariPopupPrimaryButton() {
  await runAppleScript(`
    tell application "${safariAppName}"
      do JavaScript "document.querySelector('#primaryAction')?.click();" in current tab of front window
    end tell
  `);
}

async function importSafariPairing(config) {
  const encodedConfig = Buffer.from(JSON.stringify(config), "utf8").toString(
    "base64",
  );
  const javascript = `document.querySelector('#details').open = true; document.querySelector('#recovery').open = true; document.querySelector('#pairingJson').value = atob('${encodedConfig}'); document.querySelector('#importPairing').click();`;
  const escapedJavascript = javascript
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  await runAppleScript(`
    tell application "${safariAppName}"
      do JavaScript "${escapedJavascript}" in current tab of front window
    end tell
  `);
}

async function waitForSafariPopup(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let state = null;
    try {
      state = await readSafariFrontTabState();
    } catch {
      // error-policy:J4 Transient unreadable popup state remains visibly
      // pending and becomes a timeout failure at this polling boundary.
      state = null;
    }
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for Safari popup state.");
}

async function startMockAgentServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
    }
    requests.push({
      path: url.pathname,
      authorization: req.headers.authorization ?? null,
      companionId: req.headers["x-browser-bridge-companion-id"] ?? null,
      body: body.trim() ? JSON.parse(body) : null,
    });
    const now = new Date().toISOString();

    if (url.pathname === "/chat") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Eliza</title><h1>Eliza</h1>");
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
      url.pathname === "/api/browser-bridge/companions/sync"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          companion: {
            id: "browser-bridge-safari-smoke",
            agentId: "agent-safari-smoke",
            browser: "safari",
            profileId: "default",
            profileLabel: "Default",
            label: "Agent Browser Bridge Safari smoke",
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
            lastSeenAt: now,
            pairedAt: now,
            metadata: {},
            createdAt: now,
            updatedAt: now,
          },
          tabs: [],
          currentPage: null,
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
            updatedAt: now,
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function resolveSafariPopupUrl(extensionKeys) {
  const candidates = browserBridgeSafariPopupCandidates(extensionKeys);
  for (const candidate of candidates) {
    await openSafariUrl(candidate, true);
    let state = null;
    try {
      state = await readSafariFrontTabState();
    } catch {
      // error-policy:J3 An unreadable candidate is rejected rather than
      // treated as a working Safari extension origin.
      state = null;
    }
    if (
      state &&
      typeof state.title === "string" &&
      state.title.trim().length > 0
    ) {
      return candidate;
    }
  }
  throw new Error(
    `Could not resolve a working Safari popup URL for ${safariAppDisplayName}. Tried: ${candidates.join(", ")}`,
  );
}

export async function main() {
  assertMacOs();
  await buildSignedSafariWebExtension();
  await ensureSafariDevelopMenu();
  await ensureSafariDeveloperPrerequisites();
  const extensionKeys = await installSignedSafariExtension();
  if (extensionKeys.length === 0) {
    throw new Error(
      `Safari did not register the signed ${safariAppDisplayName} extension after launching its container app.`,
    );
  }
  await enableBrowserBridgeExtensionInSafari();
  const mockServer = await startMockAgentServer();
  try {
    await openSafariUrl(`${mockServer.origin}/chat`);
    const popupUrl = await resolveSafariPopupUrl(extensionKeys);
    await openSafariUrl(popupUrl, true);
    await waitForSafariPopup(
      (state) => state.title && state.title !== "Loading extension state…",
      20_000,
    );
    await importSafariPairing({
      apiBaseUrl: mockServer.origin,
      companionId: "browser-bridge-safari-smoke",
      pairingToken: "lobr_safari_smoke_token",
      browser: "safari",
      profileId: "default",
      profileLabel: "Default",
      label: "Agent Browser Bridge Safari smoke",
    });
    await waitForSafariPopup(
      (state) => String(state.button ?? "").includes("Sync This Browser"),
      20_000,
    );
    await clickSafariPopupPrimaryButton();
    await waitForSafariPopup(
      (state) => String(state.title ?? "").includes("connected to Eliza"),
      20_000,
    );
    if (
      mockServer.requests.some(
        (request) =>
          request.path === "/api/browser-bridge/companions/auto-pair",
      )
    ) {
      throw new Error("Safari smoke observed a forbidden auto-pair request.");
    }
    const syncRequest = mockServer.requests.find(
      (request) => request.path === "/api/browser-bridge/companions/sync",
    );
    if (
      syncRequest?.authorization !== "Bearer lobr_safari_smoke_token" ||
      syncRequest?.companionId !== "browser-bridge-safari-smoke"
    ) {
      throw new Error(
        "Safari smoke sync did not use imported pairing credentials.",
      );
    }
    console.log(`${safariAppDisplayName} Safari smoke checks passed.`);
  } finally {
    await mockServer.close();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
