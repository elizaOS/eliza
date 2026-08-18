#!/usr/bin/env node
/**
 * Temporarily installs the exact Firefox build in current Firefox and proves
 * authenticated loopback pairing, sync, action progress, and completion.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const firefoxDistDir = path.join(extensionRoot, "dist", "firefox");
const firefoxBinary =
  process.env.FIREFOX_BINARY?.trim() ||
  (process.platform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : "firefox");

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Browser-Bridge-Companion-Id",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

async function startMockAgentServer() {
  const requests = [];
  let actionDelivered = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let rawBody = "";
    for await (const chunk of req) rawBody += String(chunk);
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = null;
    }
    requests.push({
      body,
      headers: req.headers,
      method: req.method ?? "GET",
      path: url.pathname,
    });

    if (url.pathname === "/chat" || url.pathname === "/action-target") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><title>Eliza Firefox Smoke</title><h1>${url.pathname}</h1>`,
      );
      return;
    }
    if (url.pathname === "/api/status") {
      sendJson(res, 200, { state: "running" });
      return;
    }
    if (url.pathname.endsWith("/auto-pair")) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const companion = {
        id: "firefox-real-smoke",
        agentId: "agent-firefox-smoke",
        browser: "firefox",
        profileId: "default",
        profileLabel: "Default",
        label: "Firefox real smoke",
        extensionVersion: "2.0.0.40002",
        connectionState: "connected",
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: false,
          grantedOrigins: [],
          incognitoEnabled: false,
        },
        lastSeenAt: nowIso(),
        pairedAt: nowIso(),
        metadata: {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      sendJson(res, 200, {
        companion,
        config: {
          apiBaseUrl: origin,
          companionId: companion.id,
          pairingToken: "lobr_firefox_real_smoke",
          browser: companion.browser,
          profileId: companion.profileId,
          profileLabel: companion.profileLabel,
          label: companion.label,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/sync")) {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const session = actionDelivered
        ? null
        : {
            id: "firefox-real-session",
            title: "Firefox open action",
            browser: "firefox",
            profileId: "default",
            tabId: null,
            status: "running",
            currentActionIndex: 0,
            actions: [
              {
                id: "open-target",
                kind: "open",
                url: `${origin}/action-target`,
              },
            ],
            metadata: {},
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
      actionDelivered = true;
      sendJson(res, 200, {
        companion: {
          id: "firefox-real-smoke",
          agentId: "agent-firefox-smoke",
          browser: "firefox",
          profileId: "default",
          profileLabel: "Default",
          label: "Firefox real smoke",
          extensionVersion: "2.0.0.40002",
          connectionState: "connected",
          permissions: body?.companion?.permissions ?? {},
          lastSeenAt: nowIso(),
          pairedAt: nowIso(),
          metadata: {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
        tabs: [],
        currentPage: null,
        settings: {
          enabled: true,
          trackingMode: "active_tabs",
          allowBrowserControl: true,
          requireConfirmationForAccountAffecting: true,
          incognitoEnabled: false,
          siteAccessMode: "granted_sites",
          grantedOrigins: [],
          blockedOrigins: [],
          maxRememberedTabs: 10,
          pauseUntil: null,
          metadata: {},
          updatedAt: nowIso(),
        },
        session,
      });
      return;
    }
    if (url.pathname.endsWith("/progress")) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname.endsWith("/complete")) {
      sendJson(res, 200, { ok: true });
      resolveCompletion(body);
      return;
    }
    if (url.pathname === "/api/website-blocker") {
      sendJson(res, 200, { active: false, websites: [] });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    completion,
    rejectCompletion,
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function removeProfile(profileDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

await run("bun", [path.join(scriptDir, "build.mjs"), "firefox"], {
  cwd: extensionRoot,
});
const mockServer = await startMockAgentServer();
const profileDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "eliza-firefox-smoke-"),
);
const child = spawn(
  "bunx",
  [
    "web-ext",
    "run",
    "--source-dir",
    firefoxDistDir,
    "--firefox",
    firefoxBinary,
    "--firefox-profile",
    profileDir,
    "--keep-profile-changes",
    "--no-reload",
    "--no-input",
    "--start-url",
    `${mockServer.origin}/chat`,
  ],
  {
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
  },
);
child.once("exit", (code) => {
  mockServer.rejectCompletion(
    new Error(`web-ext exited before completion with code ${code}`),
  );
});

const timeout = setTimeout(() => {
  mockServer.rejectCompletion(
    new Error(
      `Timed out waiting for Firefox action completion. Requests: ${JSON.stringify(mockServer.requests)}`,
    ),
  );
}, 90_000);
try {
  const result = await mockServer.completion;
  clearTimeout(timeout);
  const autoPair = mockServer.requests.find((request) =>
    request.path.endsWith("/auto-pair"),
  );
  const sync = mockServer.requests.find((request) =>
    request.path.endsWith("/sync"),
  );
  const progress = mockServer.requests.find((request) =>
    request.path.endsWith("/progress"),
  );
  if (
    autoPair?.body?.browser !== "firefox" ||
    sync?.headers?.authorization !== "Bearer lobr_firefox_real_smoke" ||
    !progress ||
    result?.status !== "done" ||
    !mockServer.requests.some((request) => request.path === "/action-target")
  ) {
    throw new Error(
      "Firefox did not complete the authenticated action contract",
    );
  }
  console.log(
    `Firefox ${firefoxBinary} temporary-install pairing/sync/action smoke passed.`,
  );
} finally {
  clearTimeout(timeout);
  if (process.platform === "win32") {
    child.kill("SIGTERM");
  } else {
    // web-ext launches Firefox as a child process, so stop the isolated process
    // group to avoid leaving the temporary browser/profile alive after proof.
    process.kill(-child.pid, "SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  await mockServer.close();
  await removeProfile(profileDir);
}
