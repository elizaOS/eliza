#!/usr/bin/env node

/**
 * Puppeteer-over-Eliza application harness.
 *
 * The harness drives only the Eliza app surface with Puppeteer. It never calls
 * browser-workspace command/eval/navigation endpoints; target-page work must be
 * performed by the agent through its built-in BROWSER action.
 */

import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_API_BASE = "http://127.0.0.1:31337";
const DEFAULT_TARGET_URL = "https://example.com/";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const execFileAsync = promisify(execFile);
const READ_ONLY_BROWSER_WORKSPACE_PATHS = new Set([
  "/api/browser-workspace",
  "/api/browser-workspace/events",
]);
const LOCAL_UI_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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
  --require-browser-action  Fail unless a fresh trajectory contains a BROWSER/PAGE_DELEGATE browser action.
  --overwrite               Delete an existing run directory before starting. Default is to reject non-empty run dirs.
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
    requireBrowserAction: false,
    overwrite: false,
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
    if (arg === "--require-browser-action") {
      options.requireBrowserAction = true;
      continue;
    }
    if (arg === "--overwrite") {
      options.overwrite = true;
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

function normalizeApiPath(path, apiBase = DEFAULT_API_BASE) {
  try {
    return new URL(path, apiBase).pathname;
  } catch {
    return path.split("?")[0] ?? path;
  }
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
  const normalizedPath = normalizeApiPath(path);
  if (normalizedPath === "/api/browser-workspace/command") {
    throw new Error("Guardrail: browser workspace command endpoint is blocked");
  }
  if (normalizedPath === "/api/browser-workspace/tabs" && upper !== "GET") {
    throw new Error("Guardrail: browser workspace tab mutation is blocked");
  }
  if (
    /^\/api\/browser-workspace\/tabs\/[^/]+\/(?:navigate|eval|show|hide)$/.test(
      normalizedPath,
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

function isRuntimeReady(result) {
  if (!result?.ok || !result.body || typeof result.body !== "object") {
    return false;
  }
  return (
    result.body.ready === true &&
    result.body.runtime === "ok" &&
    result.body.agentState === "running"
  );
}

function getChildExitStatus(stackProcess) {
  const child = stackProcess?.child;
  if (!child) return null;
  if (child.exitCode == null && child.signalCode == null) return null;
  return {
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}

async function waitForRuntimeReady(apiBase, runDir, timeoutMs, stackProcess) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  const attemptLog = makeJsonlWriter(
    artifactPath(runDir, "runtime-ready.jsonl"),
  );
  let last = null;
  let devProcessExit = null;

  try {
    while (Date.now() < deadline) {
      last = await fetchWithCapture(apiBase, "/api/health", {
        timeoutMs: 5_000,
      });
      const record = {
        ts: nowIso(),
        status: last.status,
        ok: last.ok,
        elapsedMs: last.elapsedMs,
        ready: last.body?.ready ?? null,
        runtime: last.body?.runtime ?? null,
        agentState: last.body?.agentState ?? null,
        startupPhase: last.body?.startup?.phase ?? null,
        bodyText:
          last.body === null && last.bodyText
            ? last.bodyText.slice(0, 1000)
            : undefined,
      };
      attempts.push(record);
      attemptLog.write(record);
      if (isRuntimeReady(last)) {
        await writeJson(artifactPath(runDir, "runtime-ready.json"), {
          ...record,
          attempts: attempts.length,
        });
        return last;
      }
      devProcessExit = getChildExitStatus(stackProcess);
      if (devProcessExit) break;
      await sleep(1_000);
    }
  } finally {
    await attemptLog.close();
  }

  await writeJson(artifactPath(runDir, "runtime-ready.json"), {
    ok: false,
    attempts,
    ...(devProcessExit ? { devProcessExit } : {}),
    last: last ? summarizePollResult(last) : null,
  });
  return last;
}

async function waitForUiUrl(uiUrl, runDir, timeoutMs) {
  if (!uiUrl) return null;
  const chatUrl = resolveChatUrl(uiUrl);
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  const attemptLog = makeJsonlWriter(artifactPath(runDir, "ui-ready.jsonl"));

  try {
    while (Date.now() < deadline) {
      const startedAt = Date.now();
      try {
        const response = await fetch(chatUrl, {
          headers: { Accept: "text/html,application/xhtml+xml,*/*" },
          signal: AbortSignal.timeout(3_000),
        });
        const record = {
          ts: nowIso(),
          url: chatUrl,
          status: response.status,
          ok: response.ok,
          elapsedMs: Date.now() - startedAt,
        };
        attempts.push(record);
        attemptLog.write(record);
        if (response.ok) {
          await writeJson(artifactPath(runDir, "ui-ready.json"), {
            ...record,
            attempts: attempts.length,
          });
          return record;
        }
      } catch (error) {
        const record = {
          ts: nowIso(),
          url: chatUrl,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
        attempts.push(record);
        attemptLog.write(record);
      }
      await sleep(1_000);
    }
  } finally {
    await attemptLog.close();
  }

  await writeJson(artifactPath(runDir, "ui-ready.json"), {
    ok: false,
    url: chatUrl,
    attempts,
  });
  return null;
}

async function getDescendantPids(rootPid) {
  if (!rootPid) return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], {
      maxBuffer: 1024 * 1024,
    });
    const childrenByParent = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const children = childrenByParent.get(ppid) ?? [];
      children.push(pid);
      childrenByParent.set(ppid, children);
    }
    const descendants = [];
    const queue = [...(childrenByParent.get(rootPid) ?? [])];
    while (queue.length > 0) {
      const pid = queue.shift();
      descendants.push(pid);
      queue.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}

function signalProcess(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateSpawnedTree(child, timeoutMs = 5_000) {
  if (!child?.pid) return;
  const descendants = await getDescendantPids(child.pid);
  signalProcessGroup(child.pid, "SIGTERM");
  signalProcess(child.pid, "SIGTERM");
  for (const pid of descendants.reverse()) signalProcess(pid, "SIGTERM");

  const exited = child.exitCode != null || child.killed;
  if (!exited) {
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(timeoutMs),
    ]);
  }

  const remainingDescendants = await getDescendantPids(child.pid);
  if (child.exitCode == null && !child.killed) {
    signalProcessGroup(child.pid, "SIGKILL");
    signalProcess(child.pid, "SIGKILL");
  }
  for (const pid of remainingDescendants.reverse())
    signalProcess(pid, "SIGKILL");
}

function spawnDevDesktop(runDir) {
  const stdout = makeJsonlWriter(
    artifactPath(runDir, "dev-desktop.stdout.jsonl"),
  );
  const stderr = makeJsonlWriter(
    artifactPath(runDir, "dev-desktop.stderr.jsonl"),
  );
  const devScript =
    process.env.ELIZA_BROWSER_APP_HARNESS_DEV_SCRIPT?.trim() ||
    "dev:desktop:watch";
  const logLevel =
    process.env.ELIZA_BROWSER_APP_HARNESS_LOG_LEVEL?.trim() ||
    process.env.LOG_LEVEL ||
    "info";
  stdout.write({ ts: nowIso(), event: "spawn", script: devScript, logLevel });
  const child = spawn("bun", ["run", devScript], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      LOG_LEVEL: logLevel,
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
        await terminateSpawnedTree(child);
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
    'Because this prompt is sent from main chat, route browser work through PAGE_DELEGATE when needed, for example action PAGE_DELEGATE with page "browser" and child action "BROWSER_OPEN" for navigation.',
    `Harness run id: ${options.runId}`,
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

async function captureObservationBaseline(apiBase, runDir) {
  const browserWorkspace = await probeEndpoint(
    apiBase,
    runDir,
    "baseline-browser-workspace",
    "/api/browser-workspace",
  );
  const browserWorkspaceEvents = await probeEndpoint(
    apiBase,
    runDir,
    "baseline-browser-workspace-events",
    "/api/browser-workspace/events",
  );
  const trajectories = await probeEndpoint(
    apiBase,
    runDir,
    "baseline-trajectories",
    "/api/trajectories?limit=50&offset=0",
  );
  const localTrajectories = await captureLocalTrajectories(
    runDir,
    "baseline-local-trajectories",
  );
  const mergedTrajectories = mergeTrajectoryResults(
    trajectories,
    localTrajectories,
  );
  const baseline = {
    ts: nowIso(),
    browserWorkspace,
    browserWorkspaceEvents,
    trajectories: mergedTrajectories,
    apiTrajectories: trajectories,
    localTrajectories,
  };
  await writeJson(artifactPath(runDir, "baseline-observations.json"), {
    ts: baseline.ts,
    counts: {
      browserTabs: arrayLengthAtKey(browserWorkspace.body, ["tabs"]),
      browserEvents: arrayLengthAtKey(browserWorkspaceEvents.body, ["events"]),
      trajectories: arrayLengthAtKey(mergedTrajectories.body, [
        "trajectories",
        "items",
        "results",
        "data",
      ]),
    },
  });
  return baseline;
}

async function captureLocalTrajectories(runDir, artifactName) {
  const startedAt = Date.now();
  const trajectoryRoot = join(runDir, "trajectories");
  const items = [];
  try {
    for (const file of await listJsonFiles(trajectoryRoot)) {
      try {
        const payload = JSON.parse(await readFile(file, "utf8"));
        items.push({
          ...payload,
          _harnessArtifactPath: file,
        });
      } catch (error) {
        items.push({
          _harnessArtifactPath: file,
          _harnessReadError:
            error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch {
    // Missing trajectory directory is expected before the first prompt.
  }
  const result = {
    ok: true,
    status: 200,
    path: `local:${trajectoryRoot}`,
    method: "READ",
    contentType: "application/json",
    elapsedMs: Date.now() - startedAt,
    body: { items },
    bodyText: "",
    buffer: Buffer.alloc(0),
  };
  await saveHttpArtifact(runDir, artifactName, result);
  return result;
}

async function listJsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function mergeTrajectoryResults(apiResult, localResult) {
  const apiItems = arrayAtKey(apiResult?.body, [
    "trajectories",
    "items",
    "results",
    "data",
  ]);
  const localItems = arrayAtKey(localResult?.body, [
    "trajectories",
    "items",
    "results",
    "data",
  ]);
  const itemsByIdentity = new Map();
  for (const item of [...apiItems, ...localItems]) {
    itemsByIdentity.set(itemIdentity(item, itemsByIdentity.size), item);
  }
  const items = [...itemsByIdentity.values()];
  return {
    ok: apiResult?.ok === true || localResult?.ok === true,
    status:
      apiResult?.ok === true ? apiResult.status : (localResult?.status ?? 0),
    path: `${apiResult?.path ?? "api:missing"} + ${localResult?.path ?? "local:missing"}`,
    method: "MERGE",
    contentType: "application/json",
    elapsedMs: (apiResult?.elapsedMs ?? 0) + (localResult?.elapsedMs ?? 0),
    body: { items },
    bodyText:
      apiResult?.ok === false && localResult?.ok !== true
        ? apiResult.bodyText
        : "",
    buffer: Buffer.alloc(0),
  };
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
  return arrayAtKey(value, keys).length;
}

function arrayAtKey(value, keys) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry;
  }
  for (const entry of Object.values(value)) {
    const found = arrayAtKey(entry, keys);
    if (found.length > 0) return found;
  }
  return [];
}

function itemIdentity(item, index) {
  if (item && typeof item === "object") {
    for (const key of [
      "id",
      "tabId",
      "eventId",
      "trajectoryId",
      "traceId",
      "uuid",
    ]) {
      const value = item[key];
      if (typeof value === "string" && value.trim()) return `${key}:${value}`;
      if (typeof value === "number") return `${key}:${value}`;
    }
  }
  try {
    return `json:${JSON.stringify(item).slice(0, 4000)}`;
  } catch {
    return `index:${index}`;
  }
}

function identitySet(items) {
  return new Set(items.map((item, index) => itemIdentity(item, index)));
}

function timestampMs(item) {
  if (!item || typeof item !== "object") return null;
  for (const key of [
    "ts",
    "time",
    "timestamp",
    "createdAt",
    "updatedAt",
    "startedAt",
    "finishedAt",
  ]) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function postBaselineItems(finalItems, baselineItems, promptSubmittedAt) {
  const baselineIds = identitySet(baselineItems);
  const promptMs = promptSubmittedAt ? Date.parse(promptSubmittedAt) : NaN;
  return finalItems.filter((item, index) => {
    const id = itemIdentity(item, index);
    if (!baselineIds.has(id)) return true;
    const ts = timestampMs(item);
    return Number.isFinite(promptMs) && ts != null && ts >= promptMs - 2_000;
  });
}

function targetUrlNeedles(targetUrl) {
  const needles = new Set([targetUrl]);
  try {
    const parsed = new URL(targetUrl);
    needles.add(parsed.toString());
    needles.add(`${parsed.origin}${parsed.pathname}`);
    if (parsed.pathname.endsWith("/")) {
      needles.add(`${parsed.origin}${parsed.pathname.slice(0, -1)}`);
    }
  } catch {
    // Keep the raw target above.
  }
  return [...needles].filter(Boolean);
}

function containsAny(value, needles) {
  const haystack = JSON.stringify(value ?? "").toLowerCase();
  return needles.some((needle) =>
    haystack.includes(String(needle).toLowerCase()),
  );
}

function textContains(value, needles) {
  const haystack = JSON.stringify(value ?? "").toLowerCase();
  return needles.some((needle) => haystack.includes(needle));
}

function hasBrowserToolStage(item) {
  if (!item || typeof item !== "object") return false;
  const stages = Array.isArray(item.stages) ? item.stages : [];
  return stages.some((stage) => {
    if (!stage || typeof stage !== "object" || stage.kind !== "tool") {
      return false;
    }
    const tool = stage.tool;
    if (!tool || typeof tool !== "object") return false;
    const name = String(tool.name ?? "").toUpperCase();
    if (name.startsWith("BROWSER")) return true;
    if (name !== "PAGE_DELEGATE") return false;
    const args = tool.args;
    if (!args || typeof args !== "object") return false;
    return (
      String(args.page ?? "").toLowerCase() === "browser" ||
      String(args.action ?? "").toUpperCase().startsWith("BROWSER")
    );
  });
}

function analyzeRunArtifacts({
  baseline,
  browserWorkspace,
  browserWorkspaceEvents,
  devConsoleLog,
  trajectories,
  options,
  promptDelivery,
  promptSubmittedAt,
}) {
  const browserTabs = arrayAtKey(browserWorkspace.body, ["tabs"]);
  const browserEvents = arrayAtKey(browserWorkspaceEvents.body, ["events"]);
  const trajectoryItems = arrayAtKey(trajectories.body, [
    "trajectories",
    "items",
    "results",
    "data",
  ]);
  const baselineBrowserTabs = arrayAtKey(baseline?.browserWorkspace?.body, [
    "tabs",
  ]);
  const baselineBrowserEvents = arrayAtKey(
    baseline?.browserWorkspaceEvents?.body,
    ["events"],
  );
  const baselineTrajectoryItems = arrayAtKey(baseline?.trajectories?.body, [
    "trajectories",
    "items",
    "results",
    "data",
  ]);
  const postPromptBrowserTabs = postBaselineItems(
    browserTabs,
    baselineBrowserTabs,
    promptSubmittedAt,
  );
  const postPromptBrowserEvents = postBaselineItems(
    browserEvents,
    baselineBrowserEvents,
    promptSubmittedAt,
  );
  const postPromptTrajectories = postBaselineItems(
    trajectoryItems,
    baselineTrajectoryItems,
    promptSubmittedAt,
  );
  const targetNeedles = targetUrlNeedles(options.targetUrl);
  const targetTabMatches = postPromptBrowserTabs.filter((item) =>
    containsAny(item, targetNeedles),
  );
  const targetEventMatches = postPromptBrowserEvents.filter((item) =>
    containsAny(item, targetNeedles),
  );
  const trajectoryRunMarkerMatches = postPromptTrajectories.filter((item) =>
    containsAny(item, [options.runId, ...targetNeedles]),
  );
  const browserActionMatches =
    postPromptTrajectories.filter(hasBrowserToolStage);
  const browserActionWithProvenanceMatches = browserActionMatches.filter(
    (item) => containsAny(item, [options.runId, ...targetNeedles]),
  );
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
      passed: !options.requireBrowserTab || targetTabMatches.length > 0,
      observed: {
        total: browserTabs.length,
        postPrompt: postPromptBrowserTabs.length,
        targetMatches: targetTabMatches.length,
      },
    },
    {
      name: "browser-events",
      required: options.requireBrowserEvents,
      passed: !options.requireBrowserEvents || targetEventMatches.length > 0,
      observed: {
        total: browserEvents.length,
        postPrompt: postPromptBrowserEvents.length,
        targetMatches: targetEventMatches.length,
      },
    },
    {
      name: "trajectory",
      required: options.requireTrajectory,
      passed:
        !options.requireTrajectory || trajectoryRunMarkerMatches.length > 0,
      observed: {
        total: trajectoryItems.length,
        postPrompt: postPromptTrajectories.length,
        runMarkerMatches: trajectoryRunMarkerMatches.length,
        browserActionMatches: browserActionMatches.length,
      },
    },
    {
      name: "browser-action",
      required: options.requireBrowserAction,
      passed:
        !options.requireBrowserAction ||
        browserActionWithProvenanceMatches.length > 0,
      observed: {
        postPromptBrowserActionMatches: browserActionMatches.length,
        browserActionWithProvenanceMatches:
          browserActionWithProvenanceMatches.length,
      },
    },
  ];
  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
  return {
    schema: "elizaos.browser-app-harness.analysis/v1",
    ts: nowIso(),
    ok: failedAssertions.length === 0,
    promptDelivery,
    promptSubmittedAt,
    targetUrl: options.targetUrl,
    counts: {
      browserTabs: browserTabs.length,
      browserEvents: browserEvents.length,
      trajectories: trajectoryItems.length,
      endpointErrors: endpointErrors.length,
    },
    postPromptCounts: {
      browserTabs: postPromptBrowserTabs.length,
      browserEvents: postPromptBrowserEvents.length,
      trajectories: postPromptTrajectories.length,
    },
    signals: {
      consoleHasErrors,
      targetTabMatches: targetTabMatches.length,
      targetEventMatches: targetEventMatches.length,
      trajectoryRunMarkerMatches: trajectoryRunMarkerMatches.length,
      browserActionMatches: browserActionMatches.length,
      browserActionWithProvenanceMatches:
        browserActionWithProvenanceMatches.length,
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
        const normalizedPath = normalizeApiPath(path, apiBase);
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

async function captureAppScreenshots(uiUrl, runDir, originGuard) {
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
    const pageOriginGuard = installPuppeteerOriginGuard(page, originGuard);
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
    pageOriginGuard.assert("initial app load");
    await page.screenshot({
      path: artifactPath(runDir, "eliza-app-initial.png"),
      fullPage: true,
    });
    await writeJson(artifactPath(runDir, "puppeteer-screenshot.json"), {
      ts: nowIso(),
      uiUrl,
      chatUrl: resolveChatUrl(uiUrl),
      executablePath,
      allowedOrigins: originGuard.allowedOrigins,
      screenshots: ["eliza-app-initial.png"],
    });
    return { browser, page, consoleLog, pageOriginGuard };
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

function urlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function isLocalUiUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      LOCAL_UI_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function addStackUiOrigins(allowedOrigins, stackBody) {
  const rendererUrl = stackBody?.desktop?.rendererUrl;
  if (typeof rendererUrl === "string" && rendererUrl.trim()) {
    const origin = urlOrigin(rendererUrl.trim());
    if (origin) allowedOrigins.add(origin);
  }
  const uiPort = stackBody?.desktop?.uiPort;
  const parsedPort =
    typeof uiPort === "number"
      ? uiPort
      : typeof uiPort === "string" && uiPort.trim()
        ? Number(uiPort)
        : null;
  if (Number.isInteger(parsedPort) && parsedPort > 0) {
    allowedOrigins.add(`http://127.0.0.1:${parsedPort}`);
    allowedOrigins.add(`http://localhost:${parsedPort}`);
  }
}

function validateElizaUiUrl(uiUrl, stackBody) {
  if (!uiUrl) {
    throw new Error(
      "No Eliza UI URL discovered. Pass --ui-url or run with /api/dev/stack available.",
    );
  }
  const allowedOrigins = new Set();
  addStackUiOrigins(allowedOrigins, stackBody);
  const origin = urlOrigin(uiUrl);
  if (!origin) throw new Error(`Invalid Eliza UI URL: ${uiUrl}`);
  if (isLocalUiUrl(uiUrl)) allowedOrigins.add(origin);
  if (!allowedOrigins.has(origin)) {
    throw new Error(
      `Refusing to drive non-Eliza UI origin ${origin}. Allowed origins: ${[
        ...allowedOrigins,
      ].join(", ")}`,
    );
  }
  return {
    origin,
    allowedOrigins: [...allowedOrigins],
  };
}

function assertElizaAppPageUrl(url, originGuard, context) {
  if (!url || url === "about:blank") return;
  const origin = urlOrigin(url);
  if (!origin || !originGuard.allowedOrigins.includes(origin)) {
    throw new Error(
      `Puppeteer navigation guard blocked ${context}: ${url}. Puppeteer may only drive the Eliza app UI origins: ${originGuard.allowedOrigins.join(", ")}`,
    );
  }
}

function installPuppeteerOriginGuard(page, originGuard) {
  const errors = [];
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      assertElizaAppPageUrl(frame.url(), originGuard, "main frame navigation");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  return {
    assert(context) {
      assertElizaAppPageUrl(page.url(), originGuard, context);
      if (errors.length > 0) {
        throw new Error(errors.join("\n"));
      }
    },
  };
}

async function seedElizaAppStorage(page) {
  await page.evaluateOnNewDocument(() => {
    try {
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
    } catch {
      // Chrome error pages can block storage access while the dev server restarts.
    }
  });
}

async function setComposerValue(page, selector, prompt) {
  await page.$eval(
    selector,
    (node, value) => {
      node.focus();
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(node),
        "value",
      );
      if (descriptor?.set) {
        descriptor.set.call(node, value);
      } else {
        node.value = value;
      }
      node.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value,
        }),
      );
      node.dispatchEvent(new Event("change", { bubbles: true }));
    },
    prompt,
  );

  const valueLength = await page.$eval(
    selector,
    (node) => node.value?.length ?? 0,
  );
  if (valueLength === prompt.length) return;

  throw new Error(
    `Composer value mismatch after DOM input: expected ${prompt.length}, got ${valueLength}`,
  );
}

function extractPromptMarker(prompt) {
  const marker = /^Harness run id: .+$/m.exec(prompt)?.[0]?.trim();
  if (marker) return marker;
  return prompt.trim().split(/\s+/).slice(0, 12).join(" ");
}

async function writeComposerMissingDiagnostics(page, runDir, reason) {
  const screenshot = "eliza-app-composer-missing.png";
  const html = "eliza-app-composer-missing.html";
  try {
    await page.screenshot({
      path: artifactPath(runDir, screenshot),
      fullPage: true,
    });
  } catch {
    // Best-effort diagnostic capture.
  }
  try {
    await writeFile(artifactPath(runDir, html), await page.content(), "utf8");
  } catch {
    // Best-effort diagnostic capture.
  }
  await writeJson(artifactPath(runDir, "ui-composer-ready.json"), {
    ts: nowIso(),
    ok: false,
    reason,
    screenshot,
    html,
  });
}

async function waitForComposerReady(page, runDir, selector, timeoutMs) {
  try {
    await page.waitForSelector(selector, {
      visible: true,
      timeout: timeoutMs,
    });
    const state = await page.$eval(selector, (node) => ({
      disabled: Boolean(node.disabled),
      readOnly: Boolean(node.readOnly),
      valueLength: node.value?.length ?? 0,
    }));
    await writeJson(artifactPath(runDir, "ui-composer-ready.json"), {
      ts: nowIso(),
      ok: true,
      selector,
      state,
    });
    return state;
  } catch (error) {
    const reason =
      error instanceof Error ? error.stack || error.message : String(error);
    await writeComposerMissingDiagnostics(page, runDir, reason);
    throw new Error(`Chat composer did not mount: ${reason}`);
  }
}

async function readUiPromptState(page, marker) {
  return await page.evaluate((promptMarker) => {
    const messages = Array.from(
      document.querySelectorAll('[data-testid="chat-message"]'),
    ).map((node) => ({
      role: node.getAttribute("data-role") || "",
      text: node.textContent || "",
    }));
    const composer = document.querySelector(
      '[data-testid="chat-composer-textarea"]',
    );
    return {
      url: window.location.href,
      activeConversationId:
        window.localStorage.getItem("eliza:chat:activeConversationId") || null,
      messageCount: messages.length,
      userMessageCount: messages.filter((message) => message.role === "user")
        .length,
      markerSeen: promptMarker
        ? (document.body.innerText || "").includes(promptMarker)
        : null,
      composerValueLength:
        composer && "value" in composer ? composer.value.length : null,
    };
  }, marker);
}

async function waitForPromptAccepted(page, runDir, before, marker, timeoutMs) {
  try {
    await page.waitForFunction(
      ({ beforeUserMessageCount, promptMarker }) => {
        const userMessages = Array.from(
          document.querySelectorAll(
            '[data-testid="chat-message"][data-role="user"]',
          ),
        );
        const markerSeen = promptMarker
          ? (document.body.innerText || "").includes(promptMarker)
          : true;
        return userMessages.length > beforeUserMessageCount && markerSeen;
      },
      { timeout: timeoutMs },
      {
        beforeUserMessageCount: before.userMessageCount,
        promptMarker: marker,
      },
    );
    return await readUiPromptState(page, marker);
  } catch (error) {
    const screenshot = "eliza-app-prompt-not-accepted.png";
    const html = "eliza-app-prompt-not-accepted.html";
    try {
      await page.screenshot({
        path: artifactPath(runDir, screenshot),
        fullPage: true,
      });
    } catch {
      // Best-effort diagnostic capture.
    }
    try {
      await writeFile(artifactPath(runDir, html), await page.content(), "utf8");
    } catch {
      // Best-effort diagnostic capture.
    }
    const after = await readUiPromptState(page, marker).catch(() => null);
    await writeJson(artifactPath(runDir, "ui-prompt-not-accepted.json"), {
      ts: nowIso(),
      ok: false,
      marker,
      before,
      after,
      screenshot,
      html,
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    });
    throw error;
  }
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
    session.pageOriginGuard?.assert("chat navigation");
  }

  const composerSelector = '[data-testid="chat-composer-textarea"]';
  const actionSelector = '[data-testid="chat-composer-action"]';
  const marker = extractPromptMarker(prompt);
  await waitForComposerReady(page, runDir, composerSelector, 180_000);
  const beforePrompt = await readUiPromptState(page, marker);
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
  session.pageOriginGuard?.assert("after chat composer submit");
  const afterPrompt = await waitForPromptAccepted(
    page,
    runDir,
    beforePrompt,
    marker,
    30_000,
  );
  await page.screenshot({
    path: artifactPath(runDir, "eliza-app-after-ui-prompt.png"),
    fullPage: true,
  });
  await writeJson(artifactPath(runDir, "ui-prompt.json"), {
    ts: nowIso(),
    uiUrl,
    chatUrl,
    promptLength: prompt.length,
    promptMarker: marker,
    composerSelector,
    actionSelector,
    beforePrompt,
    afterPrompt,
    screenshot: "eliza-app-after-ui-prompt.png",
  });
  return {
    ok: true,
    status: 0,
    path: "puppeteer://eliza-app/chat",
    method: "UI",
    body: {
      conversationId: afterPrompt.activeConversationId,
      markerSeen: afterPrompt.markerSeen,
      userMessageCount: afterPrompt.userMessageCount,
    },
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
  const parsedPort =
    typeof uiPort === "number"
      ? uiPort
      : typeof uiPort === "string" && uiPort.trim()
        ? Number(uiPort)
        : null;
  if (Number.isInteger(parsedPort) && parsedPort > 0) {
    return `http://127.0.0.1:${parsedPort}`;
  }
  return "";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runParentDir = resolve(ROOT, "tmp", "eliza-browser-harness");
  const runDir = resolve(runParentDir, options.runId);
  await mkdir(runParentDir, { recursive: true });
  if (existsSync(runDir)) {
    const existing = await readdir(runDir).catch(() => []);
    if (existing.length > 0 && !options.overwrite) {
      throw new Error(
        `Run directory already exists and is not empty: ${runDir}. Use a fresh --run-id or pass --overwrite.`,
      );
    }
    if (existing.length > 0 && options.overwrite) {
      await rm(runDir, { recursive: true, force: true });
    }
  }
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
  let promptConversationId = null;
  let runtimeReady = null;
  let uiReady = null;
  let uiUrl = "";
  let uiOriginGuard = null;
  let baseline = null;
  let promptSubmittedAt = null;
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
    } else if (!initialHealth.ok && options.noLaunch) {
      throw new Error(
        `No running Eliza API at ${options.apiBase}; remove --no-launch or pass --api-base`,
      );
    }

    runtimeReady = await waitForRuntimeReady(
      options.apiBase,
      runDir,
      300_000,
      stackProcess,
    );
    if (!isRuntimeReady(runtimeReady)) {
      const devProcessExit = getChildExitStatus(stackProcess);
      if (devProcessExit) {
        throw new Error(
          `Eliza dev stack exited before runtime became ready (exitCode=${devProcessExit.exitCode ?? "null"}, signal=${devProcessExit.signalCode ?? "null"})`,
        );
      }
      throw new Error(
        `Eliza runtime did not become ready on ${options.apiBase}/api/health`,
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
    uiUrl = resolveUiUrlFromStack(options, stack.body);
    uiOriginGuard = validateElizaUiUrl(uiUrl, stack.body);
    await writeJson(artifactPath(runDir, "discovery.json"), {
      ts: nowIso(),
      apiBase: options.apiBase,
      uiUrl,
      uiOriginGuard,
      health: { ok: health.ok, status: health.status },
      status: { ok: status.ok, status: status.status },
      devStack: { ok: stack.ok, status: stack.status },
    });
    uiReady = await waitForUiUrl(uiUrl, runDir, 120_000);
    if (uiUrl && !uiReady?.ok) {
      throw new Error(
        `UI did not become reachable at ${resolveChatUrl(uiUrl)}`,
      );
    }

    puppeteerSession = await captureAppScreenshots(
      uiUrl,
      runDir,
      uiOriginGuard,
    );
    if (options.promptVia === "api") {
      conversation = await createConversation(options.apiBase, runDir);
    }
    baseline = await captureObservationBaseline(options.apiBase, runDir);
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
    promptSubmittedAt = nowIso();
    if (!promptResult.ok) {
      throw new Error(
        `Prompt request failed: HTTP ${promptResult.status} ${promptResult.bodyText}`,
      );
    }
    promptConversationId =
      conversation?.id ?? promptResult.body?.conversationId ?? null;

    await pollReadOnlyEndpoints(
      options.apiBase,
      runDir,
      options,
      promptConversationId,
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
    const finalLocalTrajectories = await captureLocalTrajectories(
      runDir,
      "final-local-trajectories",
    );
    const mergedFinalTrajectories = mergeTrajectoryResults(
      finalTrajectories,
      finalLocalTrajectories,
    );
    await saveHttpArtifact(
      runDir,
      "final-trajectories-merged",
      mergedFinalTrajectories,
    );
    const finalDevConsoleLog = await probeEndpoint(
      options.apiBase,
      runDir,
      "final-dev-console-log",
      "/api/dev/console-log?maxLines=800&maxBytes=512000",
    );
    const analysis = analyzeRunArtifacts({
      baseline,
      browserWorkspace: finalBrowserWorkspace,
      browserWorkspaceEvents: finalBrowserWorkspaceEvents,
      devConsoleLog: finalDevConsoleLog,
      trajectories: mergedFinalTrajectories,
      options,
      promptDelivery: options.promptVia,
      promptSubmittedAt,
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
      conversationId: promptConversationId,
      promptDelivery: options.promptVia,
      promptStatus: promptResult.status,
      promptOk: promptResult.ok,
      runtimeReady: runtimeReady ? summarizePollResult(runtimeReady) : null,
      uiReady,
      uiUrl,
      uiOriginGuard,
      promptSubmittedAt,
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
      conversationId: promptConversationId ?? conversation?.id ?? null,
      promptDelivery: options.promptVia,
      promptStatus: promptResult?.status ?? null,
      runtimeReady: runtimeReady ? summarizePollResult(runtimeReady) : null,
      uiReady,
      uiUrl,
      uiOriginGuard,
      promptSubmittedAt,
      diagnostics: {
        runtimeReady: "runtime-ready.json",
        uiReady: "ui-ready.json",
        uiReadyAttempts: "ui-ready.jsonl",
        composerReady: "ui-composer-ready.json",
        composerMissingScreenshot: "eliza-app-composer-missing.png",
        promptNotAccepted: "ui-prompt-not-accepted.json",
      },
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
