#!/usr/bin/env node

/**
 * Puppeteer-over-Eliza application harness.
 *
 * The harness drives only the Eliza app surface with Puppeteer. It never calls
 * browser-workspace command/eval/navigation endpoints; target-page work must be
 * performed by the agent through its built-in BROWSER action.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_API_BASE = "http://127.0.0.1:31337";
const DEFAULT_TARGET_URL = "https://example.com/";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const READ_ONLY_BROWSER_WORKSPACE_PATHS = new Set([
  "/api/browser-workspace",
  "/api/browser-workspace/events",
]);

function usage() {
  return `Usage: bun scripts/eliza-browser-app-harness.mjs [options]

Options:
  --dry-run                 Print and write the planned run; do not launch, prompt, or poll.
  --no-launch               Attach to an already-running Eliza stack.
  --prompt <text>           User task for the Eliza agent. The harness wraps it with BROWSER-action instructions.
  --prompt-via-ui           Type the prompt into the Eliza app chat UI with Puppeteer. Default.
  --prompt-via-api          Send the prompt through the conversation API instead of the UI.
  --require-browser-tab     Fail unless a browser workspace tab is observed by the end of the run.
  --require-browser-events  Fail unless browser workspace events are observed by the end of the run.
  --require-trajectory      Fail unless a trajectory record is observed by the end of the run.
  --target-url <url>        Target URL for the agent's BROWSER action task. Default: ${DEFAULT_TARGET_URL}
  --timeout <ms|30s|2m>     Total poll timeout after sending the prompt. Default: ${DEFAULT_TIMEOUT_MS}
  --api-base <url>          Eliza API base URL. Default: ${DEFAULT_API_BASE}
  --ui-url <url>            Eliza app URL for Puppeteer screenshots. Defaults from /api/dev/stack.
  --run-id <id>             Artifact run id. Default: timestamp + random suffix.
  --poll-interval <ms|2s>   Poll cadence. Default: ${DEFAULT_POLL_INTERVAL_MS}
  --help                    Show this help.
`;
}

function parseDuration(raw, label) {
  if (!raw || typeof raw !== "string") {
    throw new Error(`${label} requires a value`);
  }
  const trimmed = raw.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(trimmed);
  if (!match) {
    throw new Error(`${label} must be a number with optional ms/s/m suffix`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const ms = Math.round(value * multiplier);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return ms;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    noLaunch: false,
    prompt: "",
    promptVia: "ui",
    requireBrowserTab: false,
    requireBrowserEvents: false,
    requireTrajectory: false,
    targetUrl: DEFAULT_TARGET_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    apiBase: process.env.ELIZA_API_BASE?.trim() || DEFAULT_API_BASE,
    uiUrl: process.env.ELIZA_UI_URL?.trim() || "",
    runId: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-launch") {
      options.noLaunch = true;
      continue;
    }
    if (arg === "--prompt-via-ui") {
      options.promptVia = "ui";
      continue;
    }
    if (arg === "--prompt-via-api") {
      options.promptVia = "api";
      continue;
    }
    if (arg === "--require-browser-tab") {
      options.requireBrowserTab = true;
      continue;
    }
    if (arg === "--require-browser-events") {
      options.requireBrowserEvents = true;
      continue;
    }
    if (arg === "--require-trajectory") {
      options.requireTrajectory = true;
      continue;
    }
    const readValue = (name) => {
      const inlinePrefix = `${name}=`;
      if (arg.startsWith(inlinePrefix)) return arg.slice(inlinePrefix.length);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      i += 1;
      return next;
    };
    if (arg === "--prompt" || arg.startsWith("--prompt=")) {
      options.prompt = readValue("--prompt");
      continue;
    }
    if (arg === "--target-url" || arg.startsWith("--target-url=")) {
      options.targetUrl = readValue("--target-url");
      continue;
    }
    if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = parseDuration(readValue("--timeout"), "--timeout");
      continue;
    }
    if (arg === "--api-base" || arg.startsWith("--api-base=")) {
      options.apiBase = readValue("--api-base");
      continue;
    }
    if (arg === "--ui-url" || arg.startsWith("--ui-url=")) {
      options.uiUrl = readValue("--ui-url");
      continue;
    }
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      options.runId = readValue("--run-id");
      continue;
    }
    if (arg === "--poll-interval" || arg.startsWith("--poll-interval=")) {
      options.pollIntervalMs = parseDuration(
        readValue("--poll-interval"),
        "--poll-interval",
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.apiBase = stripTrailingSlash(options.apiBase);
  if (options.uiUrl) options.uiUrl = stripTrailingSlash(options.uiUrl);
  try {
    options.targetUrl = new URL(options.targetUrl).toString();
  } catch {
    throw new Error(`--target-url is not a valid URL: ${options.targetUrl}`);
  }
  if (!options.runId) {
    options.runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
  return options;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function artifactPath(runDir, name) {
  return join(runDir, name);
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeJsonlWriter(file) {
  const stream = createWriteStream(file, { flags: "a" });
  return {
    write(record) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
    close() {
      return new Promise((resolveClose) => stream.end(resolveClose));
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function apiHeaders() {
  const token =
    process.env.ELIZA_API_TOKEN?.trim() ||
    process.env.ELIZAOS_API_TOKEN?.trim() ||
    "";
  return {
    Accept: "application/json, text/plain, image/png, */*",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function assertAllowedHarnessRequest(method, path) {
  const upper = method.toUpperCase();
  if (path === "/api/browser-workspace/command") {
    throw new Error("Guardrail: browser workspace command endpoint is blocked");
  }
  if (path === "/api/browser-workspace/tabs" && upper !== "GET") {
    throw new Error("Guardrail: browser workspace tab mutation is blocked");
  }
  if (
    /^\/api\/browser-workspace\/tabs\/[^/]+\/(?:navigate|eval|show|hide)$/.test(
      path,
    )
  ) {
    throw new Error(
      "Guardrail: browser workspace tab navigation/eval/show/hide endpoints are blocked",
    );
  }
}

async function fetchWithCapture(apiBase, path, options = {}) {
  const method = options.method ?? "GET";
  assertAllowedHarnessRequest(method, path);
  const url = `${apiBase}${path}`;
  const startedAt = Date.now();
  const headers = {
    ...apiHeaders(),
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    let body = null;
    let bodyText = "";
    if (contentType.includes("application/json")) {
      bodyText = buffer.toString("utf8");
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = null;
      }
    } else if (!contentType.includes("image/png")) {
      bodyText = buffer.toString("utf8");
    }
    return {
      ok: response.ok,
      status: response.status,
      path,
      method,
      contentType,
      elapsedMs: Date.now() - startedAt,
      body,
      bodyText,
      buffer,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      path,
      method,
      contentType: "",
      elapsedMs: Date.now() - startedAt,
      body: null,
      bodyText:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      buffer: Buffer.alloc(0),
    };
  }
}

async function saveHttpArtifact(runDir, name, result) {
  const metadata = {
    ts: nowIso(),
    method: result.method,
    path: result.path,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    elapsedMs: result.elapsedMs,
  };
  if (result.contentType.includes("image/png") && result.buffer.length > 0) {
    const file = artifactPath(runDir, `${name}.png`);
    await writeFile(file, result.buffer);
    await writeJson(artifactPath(runDir, `${name}.json`), {
      ...metadata,
      file,
    });
    return;
  }
  if (result.body !== null) {
    await writeJson(artifactPath(runDir, `${name}.json`), {
      ...metadata,
      body: result.body,
    });
    return;
  }
  await writeFile(
    artifactPath(runDir, `${name}.txt`),
    result.bodyText || "",
    "utf8",
  );
  await writeJson(artifactPath(runDir, `${name}.json`), metadata);
}

async function probeEndpoint(apiBase, runDir, name, path, options = {}) {
  const result = await fetchWithCapture(apiBase, path, options);
  await saveHttpArtifact(runDir, name, result);
  return result;
}

async function waitForEndpoint(apiBase, path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fetchWithCapture(apiBase, path, { timeoutMs: 3_000 });
    if (last.ok) return last;
    await sleep(1_000);
  }
  return last;
}

function spawnDevDesktop(runDir) {
  const stdout = makeJsonlWriter(
    artifactPath(runDir, "dev-desktop.stdout.jsonl"),
  );
  const stderr = makeJsonlWriter(
    artifactPath(runDir, "dev-desktop.stderr.jsonl"),
  );
  const child = spawn("bun", ["run", "dev:desktop"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELIZA_BROWSER_APP_HARNESS_RUN_ID:
        process.env.ELIZA_BROWSER_APP_HARNESS_RUN_ID ?? "",
      MILADY_TRAJECTORY_DIR:
        process.env.MILADY_TRAJECTORY_DIR ?? join(runDir, "trajectories"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      stdout.write({ ts: nowIso(), line });
    }
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      stderr.write({ ts: nowIso(), line });
    }
  });
  child.on("exit", (code, signal) => {
    stdout.write({ ts: nowIso(), event: "exit", code, signal });
    stderr.write({ ts: nowIso(), event: "exit", code, signal });
  });

  return {
    child,
    async close() {
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveExit) => child.once("exit", resolveExit)),
          sleep(5_000).then(() => {
            if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
          }),
        ]);
      }
      await stdout.close();
      await stderr.close();
    },
  };
}

function composeAgentPrompt(options) {
  const task = options.prompt?.trim()
    ? options.prompt.trim()
    : `Open the target URL and summarize what the page is for.`;
  return [
    "Use the built-in BROWSER action for this task.",
    `Target URL: ${options.targetUrl}`,
    `Task: ${task}`,
    "Do not ask the harness to click, type, navigate, or evaluate target pages; perform browser work through your own BROWSER action and report the result in chat.",
  ].join("\n");
}

async function createConversation(apiBase, runDir) {
  const result = await fetchWithCapture(apiBase, "/api/conversations", {
    method: "POST",
    body: {
      title: "Browser app harness",
      metadata: {
        scope: "task",
        taskId: "eliza-browser-app-harness",
      },
    },
    timeoutMs: 20_000,
  });
  await saveHttpArtifact(runDir, "conversation-create", result);
  if (!result.ok || !result.body?.conversation?.id) {
    throw new Error(
      `Failed to create conversation: HTTP ${result.status} ${result.bodyText}`,
    );
  }
  return result.body.conversation;
}

async function sendConversationPrompt(apiBase, runDir, conversationId, prompt) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
  const result = await fetchWithCapture(apiBase, path, {
    method: "POST",
    body: {
      text: prompt,
      channelType: "dm",
      source: "eliza-browser-app-harness",
      metadata: {
        source: "eliza-browser-app-harness",
      },
    },
    timeoutMs: 180_000,
  });
  await saveHttpArtifact(runDir, "conversation-prompt-response", result);
  return result;
}

function summarizePollResult(result) {
  return {
    ts: nowIso(),
    path: result.path,
    method: result.method,
    status: result.status,
    ok: result.ok,
    contentType: result.contentType,
    elapsedMs: result.elapsedMs,
    body: result.body,
    bodyText:
      result.body === null && result.bodyText
        ? result.bodyText.slice(0, 20_000)
        : undefined,
  };
}

function arrayLengthAtKey(value, keys) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  for (const key of keys) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry.length;
  }
  for (const entry of Object.values(value)) {
    const count = arrayLengthAtKey(entry, keys);
    if (count > 0) return count;
  }
  return 0;
}

function textContains(value, needles) {
  const haystack = JSON.stringify(value ?? "").toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function analyzeRunArtifacts({
  browserWorkspace,
  browserWorkspaceEvents,
  devConsoleLog,
  trajectories,
  options,
  promptDelivery,
}) {
  const browserTabCount = arrayLengthAtKey(browserWorkspace.body, ["tabs"]);
  const browserEventCount = arrayLengthAtKey(browserWorkspaceEvents.body, [
    "events",
  ]);
  const trajectoryCount = arrayLengthAtKey(trajectories.body, [
    "trajectories",
    "items",
    "results",
    "data",
  ]);
  const endpointErrors = [
    browserWorkspace,
    browserWorkspaceEvents,
    trajectories,
    devConsoleLog,
  ]
    .filter((result) => result.status >= 400 || result.status === 0)
    .map((result) => ({
      path: result.path,
      status: result.status,
      bodyText: result.bodyText?.slice(0, 1000) || undefined,
    }));
  const consoleHasErrors = textContains(
    devConsoleLog.body ?? devConsoleLog.bodyText,
    ["error", "exception", "uncaught", "failed"],
  );
  const assertions = [
    {
      name: "browser-tab",
      required: options.requireBrowserTab,
      passed: !options.requireBrowserTab || browserTabCount > 0,
      observed: browserTabCount,
    },
    {
      name: "browser-events",
      required: options.requireBrowserEvents,
      passed: !options.requireBrowserEvents || browserEventCount > 0,
      observed: browserEventCount,
    },
    {
      name: "trajectory",
      required: options.requireTrajectory,
      passed: !options.requireTrajectory || trajectoryCount > 0,
      observed: trajectoryCount,
    },
  ];
  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
  return {
    schema: "elizaos.browser-app-harness.analysis/v1",
    ts: nowIso(),
    ok: failedAssertions.length === 0,
    promptDelivery,
    targetUrl: options.targetUrl,
    counts: {
      browserTabs: browserTabCount,
      browserEvents: browserEventCount,
      trajectories: trajectoryCount,
      endpointErrors: endpointErrors.length,
    },
    signals: {
      consoleHasErrors,
    },
    assertions,
    failedAssertions,
    endpointErrors,
  };
}

async function pollReadOnlyEndpoints(apiBase, runDir, options, conversationId) {
  const pollLog = makeJsonlWriter(artifactPath(runDir, "polls.jsonl"));
  const endpointLog = makeJsonlWriter(
    artifactPath(runDir, "browser-workspace-events.jsonl"),
  );
  const deadline = Date.now() + options.timeoutMs;
  const latest = {};
  const paths = [
    "/api/browser-workspace",
    "/api/browser-workspace/events",
    "/api/trajectories?limit=20&offset=0",
    "/api/dev/console-log?maxLines=400&maxBytes=256000",
    conversationId
      ? `/api/conversations/${encodeURIComponent(conversationId)}/messages`
      : null,
  ].filter(Boolean);

  try {
    while (Date.now() < deadline) {
      for (const path of paths) {
        const normalizedPath = path.split("?")[0];
        if (
          normalizedPath.startsWith("/api/browser-workspace") &&
          !READ_ONLY_BROWSER_WORKSPACE_PATHS.has(normalizedPath)
        ) {
          throw new Error(`Unexpected browser workspace poll path: ${path}`);
        }
        const result = await fetchWithCapture(apiBase, path, {
          timeoutMs: 10_000,
        });
        const record = summarizePollResult(result);
        pollLog.write(record);
        latest[path] = record;
        if (normalizedPath === "/api/browser-workspace/events") {
          endpointLog.write(record);
        }
      }
      await sleep(options.pollIntervalMs);
    }
  } finally {
    await pollLog.close();
    await endpointLog.close();
  }

  await writeJson(artifactPath(runDir, "poll-latest.json"), latest);
  return latest;
}

function commonChromePaths() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.filter(Boolean);
}

async function resolveChromeExecutable(puppeteer) {
  for (const candidate of commonChromePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const candidate = puppeteer.executablePath?.();
    if (candidate && existsSync(candidate)) return candidate;
  } catch {
    // puppeteer-core may not know about a bundled browser.
  }
  return null;
}

async function captureAppScreenshots(uiUrl, runDir) {
  if (!uiUrl) {
    await writeJson(artifactPath(runDir, "puppeteer-screenshot-skipped.json"), {
      ts: nowIso(),
      reason:
        "No UI URL discovered. Pass --ui-url or run with dev:desktop /api/dev/stack available.",
    });
    return null;
  }

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch (error) {
    await writeJson(artifactPath(runDir, "puppeteer-screenshot-skipped.json"), {
      ts: nowIso(),
      reason: `puppeteer-core import failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }

  const executablePath = await resolveChromeExecutable(puppeteer);
  if (!executablePath) {
    await writeJson(artifactPath(runDir, "puppeteer-screenshot-skipped.json"), {
      ts: nowIso(),
      reason:
        "No Chrome/Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_PATH.",
    });
    return null;
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    protocolTimeout: 120_000,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--no-first-run",
    ],
  });
  try {
    const page = await browser.newPage();
    const consoleLog = makeJsonlWriter(
      artifactPath(runDir, "puppeteer-console.jsonl"),
    );
    page.on("console", (message) => {
      consoleLog.write({
        ts: nowIso(),
        type: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      consoleLog.write({
        ts: nowIso(),
        type: "pageerror",
        text:
          error instanceof Error ? error.stack || error.message : String(error),
      });
    });
    await seedElizaAppStorage(page);
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(resolveChatUrl(uiUrl), {
      waitUntil: "networkidle2",
      timeout: 60_000,
    });
    await page.screenshot({
      path: artifactPath(runDir, "eliza-app-initial.png"),
      fullPage: true,
    });
    await writeJson(artifactPath(runDir, "puppeteer-screenshot.json"), {
      ts: nowIso(),
      uiUrl,
      chatUrl: resolveChatUrl(uiUrl),
      executablePath,
      screenshots: ["eliza-app-initial.png"],
    });
    return { browser, page, consoleLog };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function closePuppeteer(session, runDir) {
  if (!session) return;
  try {
    await session.page.screenshot({
      path: artifactPath(runDir, "eliza-app-final.png"),
      fullPage: true,
    });
  } catch {
    // Best-effort final screenshot.
  }
  await session.consoleLog?.close();
  await session.browser.close();
}

function resolveChatUrl(uiUrl) {
  try {
    const parsed = new URL(uiUrl);
    return new URL("/chat", parsed.origin).toString();
  } catch {
    return `${stripTrailingSlash(uiUrl)}/chat`;
  }
}

async function seedElizaAppStorage(page) {
  await page.evaluateOnNewDocument(() => {
    const seededKey = "eliza:browser-app-harness-storage-seeded";
    if (sessionStorage.getItem(seededKey) === "1") return;
    localStorage.setItem("eliza:onboarding-complete", "1");
    localStorage.setItem("eliza:onboarding:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:embedded",
        kind: "local",
        label: "This device",
      }),
    );
    sessionStorage.setItem(seededKey, "1");
  });
}

async function setComposerValue(page, selector, prompt) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await page.keyboard.press("Backspace");
  await page.type(selector, prompt, { delay: 0 });

  const valueLength = await page.$eval(
    selector,
    (node) => node.value?.length ?? 0,
  );
  if (valueLength === prompt.length) return;

  await page.$eval(
    selector,
    (node, value) => {
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    prompt,
  );
}

async function sendPromptViaElizaUi(session, runDir, uiUrl, prompt) {
  const page = session?.page;
  if (!page) {
    throw new Error(
      "UI prompt delivery requires Puppeteer. Set PUPPETEER_EXECUTABLE_PATH/CHROME_PATH or pass --prompt-via-api.",
    );
  }

  const chatUrl = resolveChatUrl(uiUrl);
  if (!page.url().startsWith(chatUrl)) {
    await page.goto(chatUrl, { waitUntil: "networkidle2", timeout: 60_000 });
  }

  const composerSelector = '[data-testid="chat-composer-textarea"]';
  const actionSelector = '[data-testid="chat-composer-action"]';
  await page.waitForSelector(composerSelector, {
    visible: true,
    timeout: 60_000,
  });
  await setComposerValue(page, composerSelector, prompt);
  await page.waitForFunction(
    (selector) => {
      const button = document.querySelector(selector);
      return Boolean(button && !button.disabled);
    },
    { timeout: 20_000 },
    actionSelector,
  );
  await page.click(actionSelector);
  await sleep(1_000);
  await page.screenshot({
    path: artifactPath(runDir, "eliza-app-after-ui-prompt.png"),
    fullPage: true,
  });
  await writeJson(artifactPath(runDir, "ui-prompt.json"), {
    ts: nowIso(),
    uiUrl,
    chatUrl,
    promptLength: prompt.length,
    composerSelector,
    actionSelector,
    screenshot: "eliza-app-after-ui-prompt.png",
  });
  return {
    ok: true,
    status: 0,
    path: "puppeteer://eliza-app/chat",
    method: "UI",
    bodyText: "",
  };
}

function resolveUiUrlFromStack(options, stackBody) {
  if (options.uiUrl) return options.uiUrl;
  const rendererUrl = stackBody?.desktop?.rendererUrl;
  if (typeof rendererUrl === "string" && rendererUrl.trim()) {
    return stripTrailingSlash(rendererUrl.trim());
  }
  const uiPort = stackBody?.desktop?.uiPort;
  if (typeof uiPort === "number" && uiPort > 0) {
    return `http://127.0.0.1:${uiPort}`;
  }
  return "";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = resolve(ROOT, "tmp", "eliza-browser-harness", options.runId);
  await mkdir(runDir, { recursive: true });

  const plannedPrompt = composeAgentPrompt(options);
  await writeJson(artifactPath(runDir, "run-plan.json"), {
    schema: "elizaos.browser-app-harness.plan/v1",
    createdAt: nowIso(),
    root: ROOT,
    runDir,
    options: {
      ...options,
      prompt: options.prompt || null,
    },
    guardrails: [
      "Puppeteer opens only the Eliza app UI URL.",
      "When promptVia=ui, Puppeteer may type/click only the Eliza chat composer.",
      "The harness never calls /api/browser-workspace/command.",
      "The harness never calls browser workspace tab navigate/eval/show/hide mutation endpoints.",
      "Target website operation is delegated to the Eliza agent via its built-in BROWSER action.",
    ],
    plannedPrompt,
  });

  if (options.dryRun) {
    console.log(`[harness] dry run written to ${runDir}`);
    return;
  }

  let stackProcess = null;
  let puppeteerSession = null;
  let conversation = null;
  let promptResult = null;
  const startedAt = Date.now();

  try {
    const initialHealth = await fetchWithCapture(
      options.apiBase,
      "/api/health",
      {
        timeoutMs: 2_000,
      },
    );
    if (!initialHealth.ok && !options.noLaunch) {
      console.log("[harness] launching dev desktop stack");
      stackProcess = spawnDevDesktop(runDir);
      const ready = await waitForEndpoint(
        options.apiBase,
        "/api/health",
        180_000,
      );
      if (!ready?.ok) {
        throw new Error(
          `Dev desktop stack did not become healthy on ${options.apiBase}/api/health`,
        );
      }
    } else if (!initialHealth.ok && options.noLaunch) {
      throw new Error(
        `No running Eliza API at ${options.apiBase}; remove --no-launch or pass --api-base`,
      );
    }

    const health = await probeEndpoint(
      options.apiBase,
      runDir,
      "probe-health",
      "/api/health",
    );
    const status = await probeEndpoint(
      options.apiBase,
      runDir,
      "probe-status",
      "/api/status",
    );
    const stack = await probeEndpoint(
      options.apiBase,
      runDir,
      "probe-dev-stack",
      "/api/dev/stack",
    );
    const uiUrl = resolveUiUrlFromStack(options, stack.body);
    await writeJson(artifactPath(runDir, "discovery.json"), {
      ts: nowIso(),
      apiBase: options.apiBase,
      uiUrl,
      health: { ok: health.ok, status: health.status },
      status: { ok: status.ok, status: status.status },
      devStack: { ok: stack.ok, status: stack.status },
    });

    puppeteerSession = await captureAppScreenshots(uiUrl, runDir);
    if (options.promptVia === "api") {
      conversation = await createConversation(options.apiBase, runDir);
    }
    await writeJson(artifactPath(runDir, "agent-prompt.json"), {
      ts: nowIso(),
      delivery: options.promptVia,
      conversationId: conversation?.id ?? null,
      prompt: plannedPrompt,
    });
    promptResult =
      options.promptVia === "ui"
        ? await sendPromptViaElizaUi(
            puppeteerSession,
            runDir,
            uiUrl,
            plannedPrompt,
          )
        : await sendConversationPrompt(
            options.apiBase,
            runDir,
            conversation.id,
            plannedPrompt,
          );
    if (!promptResult.ok) {
      throw new Error(
        `Prompt request failed: HTTP ${promptResult.status} ${promptResult.bodyText}`,
      );
    }

    await pollReadOnlyEndpoints(
      options.apiBase,
      runDir,
      options,
      conversation?.id ?? null,
    );

    const finalBrowserWorkspace = await probeEndpoint(
      options.apiBase,
      runDir,
      "final-browser-workspace",
      "/api/browser-workspace",
    );
    const finalBrowserWorkspaceEvents = await probeEndpoint(
      options.apiBase,
      runDir,
      "final-browser-workspace-events",
      "/api/browser-workspace/events",
    );
    const finalTrajectories = await probeEndpoint(
      options.apiBase,
      runDir,
      "final-trajectories",
      "/api/trajectories?limit=50&offset=0",
    );
    const finalDevConsoleLog = await probeEndpoint(
      options.apiBase,
      runDir,
      "final-dev-console-log",
      "/api/dev/console-log?maxLines=800&maxBytes=512000",
    );
    const analysis = analyzeRunArtifacts({
      browserWorkspace: finalBrowserWorkspace,
      browserWorkspaceEvents: finalBrowserWorkspaceEvents,
      devConsoleLog: finalDevConsoleLog,
      trajectories: finalTrajectories,
      options,
      promptDelivery: options.promptVia,
    });
    await writeJson(artifactPath(runDir, "analysis.json"), analysis);
    if (!analysis.ok) {
      throw new Error(
        `Harness assertions failed: ${analysis.failedAssertions
          .map((assertion) => assertion.name)
          .join(", ")}`,
      );
    }

    await writeJson(artifactPath(runDir, "summary.json"), {
      schema: "elizaos.browser-app-harness.summary/v1",
      ok: true,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      elapsedMs: Date.now() - startedAt,
      runDir,
      apiBase: options.apiBase,
      conversationId: conversation?.id ?? null,
      promptDelivery: options.promptVia,
      promptStatus: promptResult.status,
      promptOk: promptResult.ok,
      analysis,
    });
    console.log(`[harness] complete: ${runDir}`);
  } catch (error) {
    await writeJson(artifactPath(runDir, "summary.json"), {
      schema: "elizaos.browser-app-harness.summary/v1",
      ok: false,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      elapsedMs: Date.now() - startedAt,
      runDir,
      apiBase: options.apiBase,
      conversationId: conversation?.id ?? null,
      promptStatus: promptResult?.status ?? null,
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    });
    throw error;
  } finally {
    await closePuppeteer(puppeteerSession, runDir);
    if (stackProcess) await stackProcess.close();
  }
}

main().catch((error) => {
  console.error(
    `[harness] failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
