#!/usr/bin/env node
/**
 * Local PostHog capture endpoint for e2e runs: a zero-dependency HTTP server
 * that impersonates the PostHog ingestion API so the app-side session-capture
 * module (`packages/app/src/analytics/e2e-session-capture.ts`) can stream
 * autocapture events and rrweb session-recording snapshots while Playwright
 * drives the app. Decoded events are routed per test — by
 * `properties.eliza_test_id` (registered as a super property by the app
 * module) with `$session_id`/`distinct_id` association covering stragglers —
 * and appended as JSONL under `<run>/tests/<id>/posthog/{events,snapshots}.jsonl`
 * (shapes and paths from `./contract.mjs`); unroutable traffic lands in
 * `<run>/posthog-unassigned/`.
 *
 * When a routed test dir already has the `manifest.json` the Playwright
 * reporter writes at test end, the sink registers its posthog-events /
 * posthog-snapshots artifacts in it — a safe read-modify-write because the
 * sink is the only writer after the test finishes. Flushes that land before
 * the manifest exists are covered by the shutdown sweep (SIGTERM/SIGINT),
 * which patches every test dir that has posthog JSONL on disk.
 *
 * `/decide` and `/flags` answer the minimal remote config posthog-js needs to
 * turn session recording on ({sessionRecording:{endpoint:"/s/"}}, gzip-js
 * compression); every other GET (/array/*.js, /static/*) is a 200 stub — the
 * app imports the full no-external posthog bundle, so no real script is ever
 * fetched from here.
 *
 * CLI: --port (default 8422), --repo-root <dir>, --run-id <id>. Point the
 * Playwright fixtures at it via ELIZA_E2E_POSTHOG_HOST=http://127.0.0.1:<port>.
 * Request lines are appended to `<run>/posthog-sink.log`.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readTestManifest,
  resolveRunId,
  runDir,
  testDir,
  writeTestManifest,
} from "./contract.mjs";
import {
  createEventRouter,
  decodePosthogBody,
  normalizeEvents,
} from "./posthog-payload.mjs";

const DEFAULT_PORT = 8422;

const POSTHOG_ARTIFACTS = {
  events: {
    kind: "posthog-events",
    path: "posthog/events.jsonl",
    label: "PostHog events",
  },
  snapshots: {
    kind: "posthog-snapshots",
    path: "posthog/snapshots.jsonl",
    label: "PostHog session snapshots",
  },
};

// Minimal FlagsResponse/RemoteConfig shape (posthog-js dist/module.d.ts):
// a non-false `sessionRecording` object enables recording server-side, its
// `endpoint` steers snapshot POSTs, and `supportedCompression` opts the
// client into gzip-js request bodies.
const FLAGS_RESPONSE = {
  supportedCompression: ["gzip-js"],
  sessionRecording: { endpoint: "/s/" },
  autocapture_opt_out: false,
  capturePerformance: false,
  featureFlags: {},
  featureFlagPayloads: {},
  errorsWhileComputingFlags: false,
  flags: {},
  hasFeatureFlags: false,
  isAuthenticated: false,
  siteApps: [],
  surveys: false,
  toolbarParams: {},
  toolbarVersion: "toolbar",
};

function usage() {
  return "usage: posthog-sink.mjs [--port <n>] [--repo-root <dir>] [--run-id <id>]";
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, repoRoot: null, runId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--port") {
      const port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid --port ${JSON.stringify(value)}\n${usage()}`);
      }
      args.port = port;
      i += 1;
    } else if (flag === "--repo-root") {
      if (!value) throw new Error(`--repo-root requires a directory\n${usage()}`);
      args.repoRoot = path.resolve(value);
      i += 1;
    } else if (flag === "--run-id") {
      if (!value || !/^[a-zA-Z0-9._-]+$/.test(value)) {
        throw new Error(`invalid --run-id ${JSON.stringify(value)}\n${usage()}`);
      }
      args.runId = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(flag)}\n${usage()}`);
    }
  }
  return args;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cli = parseArgs(process.argv.slice(2));
const repoRoot = cli.repoRoot ?? path.resolve(scriptDir, "../..");
const runId = cli.runId ?? resolveRunId();
const runRoot = runDir(repoRoot, runId);

fs.mkdirSync(runRoot, { recursive: true });
const sinkLog = fs.createWriteStream(path.join(runRoot, "posthog-sink.log"), {
  flags: "a",
});

function logLine(message) {
  sinkLog.write(`${new Date().toISOString()} ${message}\n`);
}

const router = createEventRouter();

/**
 * Add the posthog artifact entries to a test manifest if it exists and lacks
 * them. Safe read-modify-write: the reporter wrote the manifest at test end
 * and never touches it again, so the sink is the only writer here.
 */
function ensureManifestArtifacts(dir, streams) {
  const manifest = readTestManifest(dir);
  if (!manifest) return;
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  let changed = false;
  for (const stream of streams) {
    const entry = POSTHOG_ARTIFACTS[stream];
    if (!artifacts.some((artifact) => artifact.kind === entry.kind)) {
      artifacts.push({ ...entry });
      changed = true;
    }
  }
  if (changed) {
    writeTestManifest(dir, { ...manifest, artifacts });
  }
}

/**
 * Append routed events to their JSONL streams and register manifest
 * artifacts. Returns a human-readable summary for the per-flush log line.
 */
function flushEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const { testId, stream } = router.route(event);
    const key = testId ?? "";
    if (!groups.has(key)) {
      groups.set(key, { testId, events: [], snapshots: [] });
    }
    groups.get(key)[stream].push(`${JSON.stringify(event)}\n`);
  }
  const summaries = [];
  for (const group of groups.values()) {
    const targetDir = group.testId
      ? path.join(testDir(repoRoot, runId, group.testId), "posthog")
      : path.join(runRoot, "posthog-unassigned");
    fs.mkdirSync(targetDir, { recursive: true });
    const written = [];
    for (const stream of ["events", "snapshots"]) {
      if (group[stream].length === 0) continue;
      fs.appendFileSync(path.join(targetDir, `${stream}.jsonl`), group[stream].join(""));
      written.push(stream);
    }
    if (group.testId) {
      ensureManifestArtifacts(testDir(repoRoot, runId, group.testId), written);
    }
    summaries.push(
      `${group.events.length} events + ${group.snapshots.length} snapshots -> ${path.relative(runRoot, targetDir)}`,
    );
  }
  return summaries;
}

/**
 * Shutdown sweep: manifests are written by the reporter AFTER a test's last
 * posthog flush, so per-flush registration can miss them — patch every test
 * dir that has posthog JSONL on disk.
 */
function sweepManifests() {
  const testsRoot = path.join(runRoot, "tests");
  if (!fs.existsSync(testsRoot)) return;
  for (const entry of fs.readdirSync(testsRoot)) {
    const dir = path.join(testsRoot, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    const streams = ["events", "snapshots"].filter((stream) =>
      fs.existsSync(path.join(dir, "posthog", `${stream}.jsonl`)),
    );
    if (streams.length > 0) {
      ensureManifestArtifacts(dir, streams);
    }
  }
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function respond(res, status, contentType, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    // posthog-js posts cross-origin from the app page; without CORS the
    // browser discards responses and retries indefinitely.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
  return status;
}

function respondJson(res, status, payload) {
  return respond(res, status, "application/json", JSON.stringify(payload));
}

function handle(req, res, url, body) {
  if (req.method === "OPTIONS") {
    return respond(res, 204, "text/plain", "");
  }
  const pathname = url.pathname;
  if (pathname.startsWith("/decide") || pathname.startsWith("/flags")) {
    return respondJson(res, 200, FLAGS_RESPONSE);
  }
  if (req.method === "POST" && (pathname.startsWith("/e") || pathname.startsWith("/s"))) {
    const decoded = decodePosthogBody(body, {
      compression: url.searchParams.get("compression") ?? "",
      contentType: req.headers["content-type"] ?? "",
    });
    if (!decoded.ok) {
      logLine(`INVALID ${req.method} ${req.url} ${decoded.reason}`);
      return respondJson(res, 400, { status: "invalid", reason: decoded.reason });
    }
    for (const summary of flushEvents(normalizeEvents(decoded.value))) {
      console.log(`[posthog-sink] ${summary}`);
      logLine(`FLUSH ${summary}`);
    }
    return respondJson(res, 200, { status: 1 });
  }
  if (req.method === "POST") {
    // Auxiliary posthog-js traffic (surveys, error tracking, …) is
    // acknowledged so the client never retries, but nothing is stored.
    return respondJson(res, 200, { status: 1 });
  }
  // GET stubs: /array/*.js, /static/*, and anything else the client probes.
  // The app bundles the recorder (full no-external build), so an empty body
  // is sufficient everywhere.
  if (pathname.endsWith(".js")) {
    return respond(res, 200, "application/javascript", "/* elizaOS e2e posthog sink stub */\n");
  }
  return respond(res, 200, "text/plain", "");
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://sink.internal");
  collectBody(req)
    .then((body) => {
      const status = handle(req, res, url, body);
      logLine(`${req.method} ${req.url} -> ${status}`);
    })
    .catch((error) => {
      // error-policy:J1 transport boundary — a malformed/aborted request gets
      // a structured 500 and a log line; the sink keeps serving the run
      const message = error instanceof Error ? error.message : String(error);
      logLine(`ERROR ${req.method} ${req.url} ${message}`);
      console.error(`[posthog-sink] request failed: ${req.method} ${req.url}: ${message}`);
      if (!res.headersSent) {
        respondJson(res, 500, { status: "error" });
      } else {
        res.end();
      }
    });
});

function shutdown(signal) {
  console.log(`[posthog-sink] ${signal} — sweeping manifests and closing`);
  sweepManifests();
  logLine(`SHUTDOWN ${signal}`);
  server.close(() => {
    sinkLog.end(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(cli.port, () => {
  console.log(
    `[posthog-sink] listening on http://127.0.0.1:${cli.port} run=${runId} root=${runRoot}`,
  );
  logLine(`LISTEN port=${cli.port} run=${runId}`);
});
