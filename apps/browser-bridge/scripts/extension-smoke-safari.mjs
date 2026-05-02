#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const safariDistDir = path.join(extensionRoot, "dist", "safari");
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

async function buildSafariWebExtension() {
  await run("bun", [path.join(scriptDir, "build.mjs"), "safari"], {
    cwd: extensionRoot,
  });
}

async function ensureSafariDevelopMenu() {
  await run("defaults", [
    "write",
    "com.apple.Safari",
    "IncludeDevelopMenu",
    "-bool",
    "true",
  ]);
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

async function clickSafariDeveloperCheckbox(label) {
  await runAppleScript(`
    tell application "System Events"
      tell process "${safariAppName}"
        tell window "${safariDeveloperWindowName}"
          tell group 1 of group 1
            click checkbox "${label}"
          end tell
        end tell
      end tell
    end tell
  `);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function ensureSafariDeveloperPrerequisites() {
  await openSafariDeveloperSettings();
  let flags = await readSafariDeveloperFlags();
  if (!flags.remoteAutomation) {
    try {
      await run("safaridriver", ["--enable"], {
        cwd: extensionRoot,
        timeoutMs: 10_000,
      });
    } catch {
      throw new Error(
        'Safari remote automation is disabled. Turn on "Allow remote automation" in Safari > Develop > Developer Settings, or run `safaridriver --enable` once in a local Terminal session, then rerun the Safari smoke test.',
      );
    }
    flags = await readSafariDeveloperFlags();
    if (!flags.remoteAutomation) {
      throw new Error(
        'Safari remote automation is still disabled. Turn on "Allow remote automation" in Safari > Develop > Developer Settings, then rerun the Safari smoke test.',
      );
    }
  }
  if (!flags.jsFromAppleEvents) {
    await clickSafariDeveloperCheckbox("Allow JavaScript from Apple Events");
    flags = await readSafariDeveloperFlags();
  }
  if (!flags.unsignedExtensions) {
    await clickSafariDeveloperCheckbox("Allow unsigned extensions");
    flags = await readSafariDeveloperFlags();
  }
  if (!flags.unsignedExtensions || flags.authPromptVisible) {
    throw new Error(
      'Safari blocked unsigned-extension automation with a local authentication prompt. Approve "Allow unsigned extensions" once in Safari > Develop > Developer Settings, then rerun `bun run test:smoke:safari`.',
    );
  }
  if (!flags.jsFromAppleEvents) {
    throw new Error(
      'Safari still has "Allow JavaScript from Apple Events" turned off. Enable it in Safari > Develop > Developer Settings, then rerun the Safari smoke test.',
    );
  }
}

async function readSafariWebExtensionsPlist() {
  try {
    const { stdout } = await run(
      "plutil",
      ["-convert", "json", "-o", "-", safariExtensionsPlist],
      {
        cwd: extensionRoot,
      },
    );
    return JSON.parse(stdout);
  } catch {
    return {};
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

async function installTemporarySafariExtension() {
  const before = await readSafariWebExtensionsPlist();
  await runAppleScript(`
    tell application "System Events"
      tell process "${safariAppName}"
        tell window "${safariDeveloperWindowName}"
          tell group 1 of group 1
            click button "Add Temporary Extension…"
          end tell
        end tell
      end tell
    end tell
    delay 1
    tell application "System Events"
      keystroke "G" using {command down, shift down}
      delay 0.5
      keystroke "${safariDistDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
      delay 0.5
      key code 36
      delay 0.5
      key code 36
    end tell
  `);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await readSafariWebExtensionsPlist();
  const addedKeys = Object.keys(after).filter(
    (key) => !Object.hasOwn(before, key),
  );
  const browserBridgeKeys = Object.keys(after).filter(
    (key) =>
      /browserbridge/i.test(key) ||
      key.startsWith(safariBundleIdentifierPrefix),
  );
  return [...new Set([...addedKeys, ...browserBridgeKeys])];
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
      "Safari did not show an Agent Browser Bridge extension row after the temporary install step. Reopen Safari > Settings > Extensions and verify that Agent Browser Bridge appears there.",
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
      set payload to do JavaScript "JSON.stringify({ title: document.querySelector('#statusTitle')?.textContent ?? document.title ?? '', detail: document.querySelector('#statusDetail')?.textContent ?? '', badge: document.querySelector('#statusBadge')?.textContent ?? '', button: document.querySelector('#autoPair')?.textContent ?? '', summary: document.querySelector('#summary')?.textContent ?? '' })" in current tab of front window
      return payload
    end tell
  `);
  return JSON.parse(raw || "{}");
}

async function clickSafariPopupPrimaryButton() {
  await runAppleScript(`
    tell application "${safariAppName}"
      do JavaScript "document.querySelector('#autoPair')?.click();" in current tab of front window
    end tell
  `);
}

async function waitForSafariPopup(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await readSafariFrontTabState().catch(() => null);
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for Safari popup state.");
}

async function startMockAgentServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    for await (const _chunk of req) {
      // Drain the request body so keep-alive clients can reuse the connection.
    }
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
          config: {
            apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
            companionId: "browser-bridge-safari-smoke",
            pairingToken: "lobr_safari_smoke_token",
            browser: "safari",
            profileId: "default",
            profileLabel: "Default",
            label: "Agent Browser Bridge Safari smoke",
          },
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
    const state = await readSafariFrontTabState().catch(() => null);
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
  await buildSafariWebExtension();
  await ensureSafariDevelopMenu();
  await ensureSafariDeveloperPrerequisites();
  const extensionKeys = await installTemporarySafariExtension();
  if (extensionKeys.length === 0) {
    throw new Error(
      `Safari did not register an ${safariAppDisplayName} temporary extension after the install step.`,
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
    const readyState = await readSafariFrontTabState();
    if (!String(readyState.button ?? "").includes("Sync This Browser")) {
      await clickSafariPopupPrimaryButton();
      await waitForSafariPopup(
        (state) => String(state.button ?? "").includes("Sync This Browser"),
        20_000,
      );
    }
    await clickSafariPopupPrimaryButton();
    await waitForSafariPopup(
      (state) => String(state.title ?? "").includes("connected to Eliza"),
      20_000,
    );
    console.log(`${safariAppDisplayName} Safari smoke checks passed.`);
  } finally {
    await mockServer.close();
  }
}

if (import.meta.main) {
  await main();
}
