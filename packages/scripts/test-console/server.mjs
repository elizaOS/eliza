#!/usr/bin/env node
/**
 * Local test console server: one process that serves the console UI, holds
 * the operator's saved credentials, and drives test runs with live status.
 *
 * Launched via `bun run test:console`. Binds 127.0.0.1 only — it holds raw
 * API keys and can execute repo code, so it must never listen on a routable
 * interface; there is deliberately no auth layer beyond that. The browser
 * gets presence/suffix hints for saved secrets, never the values.
 *
 * Surface:
 *   GET  /                      console UI (ui/index.html, self-contained)
 *   GET  /api/state             registry + connections + run snapshot + history
 *   GET  /api/events            SSE stream of run/task/log events
 *   POST /api/connections/:id   save credential values     DELETE — remove
 *   POST /api/connections/:id/verify   live probe
 *   POST /api/gates             toggle an opt-in gate
 *   POST /api/run               start a run {mode, lane, labels?, concurrency?}
 *                               concurrency is an integer 1..8 (default 3);
 *                               anything else is rejected 400 before any
 *                               discovery, credential, or OAuth side effect
 *   POST /api/run/cancel        cancel the active run
 *   GET  /api/runs/:id/log?task=<label>  persisted log text
 *   POST /api/cloud/login/start + GET /api/cloud/login/poll   device-code login
 *   GET  /oauth/google/start + /oauth/google/callback         loopback OAuth
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectionById, connectionStatus } from "./lib/connections.mjs";
import {
  completeGoogleFlow,
  DEFAULT_CLOUD_BASE_URL,
  pollCloudLogin,
  refreshGoogleAccessToken,
  startCloudLogin,
  startGoogleFlow,
} from "./lib/oauth.mjs";
import { buildRegistry, discoverPlan } from "./lib/registry.mjs";
import { RunManager } from "./lib/runner.mjs";
import {
  consoleDir,
  credentialsToEnv,
  listRuns,
  loadCredentials,
  loadHistory,
  loadRun,
  loadSettings,
  removeConnection,
  runLogPath,
  saveSettings,
  setConnection,
} from "./lib/store.mjs";
import { verifyConnection } from "./lib/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ELIZA_TEST_CONSOLE_PORT || 31338);
const HOST = "127.0.0.1";

const runManager = new RunManager();
const sseClients = new Set();

runManager.on("event", (event) => {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(frame);
});

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("body too large");
  }
  return data ? JSON.parse(data) : {};
}

function currentState() {
  const settings = loadSettings();
  const registry = buildRegistry({
    savedCredentials: loadCredentials(),
    optInToggles: settings.optInToggles ?? {},
    history: loadHistory(),
  });
  return {
    consoleDir: consoleDir(),
    registry,
    settings: {
      optInToggles: settings.optInToggles ?? {},
      cloudBaseUrl: settings.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL,
    },
    run: runManager.snapshot(),
    runs: listRuns()
      .slice(0, 25)
      .map(({ runId, lane, startedAt, finishedAt, cancelled, counts }) => ({
        runId,
        lane,
        startedAt,
        finishedAt,
        cancelled,
        counts,
      })),
  };
}

export const CONCURRENCY_DEFAULT = 3;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 8;

/**
 * Validates an operator-supplied `POST /api/run` body before anything with
 * side effects runs. The concurrency field drives process fan-out, so it is
 * bounded fail-closed: only an integer JSON number in
 * [CONCURRENCY_MIN, CONCURRENCY_MAX] is accepted; omitting it selects the
 * default. Every other shape (strings, fractions, zero, negatives, out of
 * range, null, booleans) is rejected so a malformed request can never reach
 * task discovery, credential reads, OAuth refresh, or run creation.
 */
export function validateRunRequest(body) {
  const { mode = "all", lane = "pr", labels, concurrency } = body ?? {};
  if (concurrency === undefined) {
    return { ok: true, mode, lane, labels, concurrency: CONCURRENCY_DEFAULT };
  }
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < CONCURRENCY_MIN ||
    concurrency > CONCURRENCY_MAX
  ) {
    return {
      ok: false,
      error: `concurrency must be an integer between ${CONCURRENCY_MIN} and ${CONCURRENCY_MAX}`,
    };
  }
  return { ok: true, mode, lane, labels, concurrency };
}

function selectTasks({ mode, labels }) {
  const plan = discoverPlan();
  const history = loadHistory();
  const all = [...plan.tasks];
  if (plan.cloudStep) {
    all.push({
      label: plan.cloudStep.label,
      relativeDir: "packages/cloud",
      scriptName: "test",
      parallelSafe: false,
    });
  }
  if (mode === "selection") {
    const wanted = new Set(labels ?? []);
    return all.filter((t) => wanted.has(t.label));
  }
  if (mode === "failed") {
    return all.filter((t) => history[t.label]?.status === "failed");
  }
  return all;
}

const routes = {
  "GET /api/state": (req, res) => json(res, 200, currentState()),

  "POST /api/gates": async (req, res) => {
    const { key, on } = await readBody(req);
    const settings = loadSettings();
    settings.optInToggles = { ...settings.optInToggles, [key]: Boolean(on) };
    saveSettings(settings);
    json(res, 200, { ok: true });
  },

  "POST /api/run": async (req, res) => {
    const parsed = validateRunRequest(await readBody(req));
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    const { mode, lane, labels, concurrency } = parsed;
    if (runManager.isRunning())
      return json(res, 409, { error: "run already in progress" });
    const tasks = selectTasks({ mode, labels });
    if (tasks.length === 0)
      return json(res, 400, { error: "no tasks selected" });
    const settings = loadSettings();
    const extraEnv = credentialsToEnv();
    for (const [gate, on] of Object.entries(settings.optInToggles ?? {})) {
      if (on) extraEnv[gate] = "1";
    }
    // Google access tokens expire hourly; a saved refresh token lets live
    // runs re-mint GOOGLE_CALENDAR_ACCESS_TOKEN so the calendar suite stays
    // armed without the operator re-pasting a token every hour.
    const google = loadCredentials()["google-oauth"] ?? {};
    if (
      lane === "live" &&
      google.GOOGLE_CLIENT_ID &&
      google.GOOGLE_CLIENT_SECRET &&
      google.GOOGLE_OAUTH_REFRESH_TOKEN
    ) {
      try {
        const { accessToken } = await refreshGoogleAccessToken({
          clientId: google.GOOGLE_CLIENT_ID,
          clientSecret: google.GOOGLE_CLIENT_SECRET,
          refreshToken: google.GOOGLE_OAUTH_REFRESH_TOKEN,
        });
        setConnection("google-calendar", {
          GOOGLE_CALENDAR_ACCESS_TOKEN: accessToken,
        });
        extraEnv.GOOGLE_CALENDAR_ACCESS_TOKEN = accessToken;
      } catch (error) {
        // error-policy:J4 explicit user-facing degrade — the run proceeds and
        // the calendar suite self-skips loudly; the operator sees why here.
        runManager.emit("event", {
          type: "warning",
          message: `Google token refresh failed: ${error?.message ?? error}`,
        });
      }
    }
    const runId = runManager.startRun({
      tasks,
      lane,
      extraEnv,
      concurrency: Number(concurrency) || 3,
    });
    json(res, 200, { runId, taskCount: tasks.length });
  },

  "POST /api/run/cancel": (req, res) =>
    json(res, 200, { cancelled: runManager.cancel() }),

  "POST /api/cloud/login/start": async (req, res) => {
    const settings = loadSettings();
    const result = await startCloudLogin({
      baseUrl: settings.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL,
    });
    json(res, 200, result);
  },

  "GET /api/cloud/login/poll": async (req, res, url) => {
    const settings = loadSettings();
    const result = await pollCloudLogin({
      sessionId: url.searchParams.get("sessionId"),
      baseUrl: settings.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL,
    });
    if (result.status === "authenticated" && result.apiKey) {
      setConnection("eliza-cloud", {
        ELIZAOS_CLOUD_API_KEY: result.apiKey,
        ELIZA_CLOUD_API_KEY: result.apiKey,
      });
    }
    json(res, 200, { status: result.status });
  },

  "GET /oauth/google/start": (req, res, url) => {
    const saved = loadCredentials()["google-oauth"] ?? {};
    const clientId = saved.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
    const clientSecret =
      saved.GOOGLE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return json(res, 400, {
        error:
          "save GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the Google OAuth connection first",
      });
    }
    const { authorizeUrl } = startGoogleFlow({
      clientId,
      clientSecret,
      redirectUri: `http://${HOST}:${PORT}/oauth/google/callback`,
    });
    res.writeHead(302, { Location: authorizeUrl });
    res.end();
  },

  "GET /oauth/google/callback": async (req, res, url) => {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const tokens = await completeGoogleFlow({ state, code });
    const saved = loadCredentials()["google-oauth"] ?? {};
    setConnection("google-oauth", {
      ...saved,
      ...(tokens.refreshToken
        ? { GOOGLE_OAUTH_REFRESH_TOKEN: tokens.refreshToken }
        : {}),
    });
    setConnection("google-calendar", {
      GOOGLE_CALENDAR_ACCESS_TOKEN: tokens.accessToken,
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<body style='font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh'><div>Google connected — you can close this tab and return to the test console.</div></body>",
    );
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(here, "ui", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // Connection CRUD + verify (path-parameterized, matched by prefix).
    const connectionMatch = url.pathname.match(
      /^\/api\/connections\/([a-z0-9-]+)(\/verify)?$/,
    );
    if (connectionMatch) {
      const [, id, verifySuffix] = connectionMatch;
      const connection = connectionById(id);
      if (!connection)
        return json(res, 404, { error: `unknown connection ${id}` });
      if (req.method === "POST" && verifySuffix) {
        const saved = loadCredentials()[id] ?? {};
        const { values } = connectionStatus(connection, saved);
        const result = await verifyConnection(connection, values);
        return json(res, 200, result);
      }
      if (req.method === "POST") {
        const { values } = await readBody(req);
        // Merge over what's saved: the browser only ever sends fields the
        // operator typed (it never holds raw saved secrets to echo back),
        // so a blank field means "keep the existing value".
        const merged = { ...(loadCredentials()[id] ?? {}) };
        for (const field of connection.fields) {
          const value = values?.[field.key];
          if (typeof value === "string" && value.trim() !== "")
            merged[field.key] = value.trim();
        }
        setConnection(id, merged);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        removeConnection(id);
        return json(res, 200, { ok: true });
      }
    }

    const logMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/log$/);
    if (logMatch && req.method === "GET") {
      const runId = decodeURIComponent(logMatch[1]);
      const run = loadRun(runId);
      const label = url.searchParams.get("task");
      const entry = run?.tasks?.find((t) => t.label === label);
      if (!entry) return json(res, 404, { error: "unknown run/task" });
      const file = runLogPath(runId, path.basename(entry.log, ".log"));
      if (!fs.existsSync(file)) return json(res, 404, { error: "log missing" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return fs.createReadStream(file).pipe(res);
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return await handler(req, res, url);

    json(res, 404, { error: "not found" });
  } catch (error) {
    // error-policy:J1 boundary translation — every route failure becomes a
    // structured 500 so the UI renders an error state instead of hanging.
    json(res, 500, { error: String(error?.message ?? error) });
  }
});

/**
 * True when this file is the process entrypoint. Compared via realpath on
 * both sides: Node resolves `import.meta.url` through symlinks while argv[1]
 * keeps the spelling the operator launched, so a URL/string comparison breaks
 * for symlinked checkouts, and file-URL escaping breaks it for paths with
 * spaces. Realpath-vs-realpath is stable across all of those.
 */
function isMainEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unresolvable argv[1]
    // yields an explicit "not the entrypoint", never a throw at import time.
    return false;
  }
}

/** Binds the console; exported so tests can import routes without listening. */
export function startServer() {
  server.listen(PORT, HOST, () => {
    const { port } = server.address();
    console.log(`[TestConsole] listening on http://${HOST}:${port}`);
    console.log(`[TestConsole] state dir: ${consoleDir()}`);
  });
  return server;
}

if (isMainEntrypoint()) startServer();
