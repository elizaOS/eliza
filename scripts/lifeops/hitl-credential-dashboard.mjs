#!/usr/bin/env node
/**
 * HITL credential intake dashboard v2 for the LifeOps live-validation run
 * (#11632): a loopback-only page sectioned per connector FAMILY with one
 * sub-row per AUTH PATH from the CONNECTOR_PATHS registry — each path carries
 * its own env slots, availability verdict, live probe, freshness badge, and
 * (where defined) a one-click acquisition action. OWNER/AGENT identity slots
 * render side-by-side on the paths that define them (github.pat env slots;
 * Google/X roles ride OAuth metadata or separate real accounts per the
 * owner-agent matrix doc) — those slots feed matrix states 2/3/6.
 *
 * Presence is resolved through the layered env (process.env > repo .env >
 * ~/.eliza/.env, env-layers.mjs); every field shows its
 * winning source layer and the page header prints the resolved layer file
 * paths. Saves default to ~/.eliza/.env (survives worktree churn; atomic
 * tmp+rename, mode 600) with a per-save toggle for the repo .env, and never
 * mutate process.env — probes read the merged layered map instead, so source
 * badges stay truthful. Probe outcomes are recorded per auth path into the
 * committed evidence ledger docs/testing/hitl-ledger.json (lane
 * "dashboard-probe"; no secrets, ever) which drives the freshness bands:
 * green ≤7d, yellow >7d, red >30d-or-never. Unavailable paths probe to
 * { ok: null, skip } and render gray-with-reason — never error styling.
 *
 * Secrets never leave the machine and are never echoed: responses carry
 * last-4 masks only, probe details are redacted upstream, and one-click
 * acquisitions (gh CLI token, headless SIWE cloud login, signal-cli link)
 * run server-side and save without rendering the credential. Zero
 * dependencies: node:http on 127.0.0.1, first free port from 43117, with
 * same-origin JSON POSTs bound to a per-process session token so another local
 * web page cannot drive credential writes through the operator's browser.
 * Run: bun run lifeops:hitl (add --open to launch the macOS browser).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appBase,
  CONNECTOR_PATH_ENV_NAMES,
  CONNECTOR_PATHS,
  checkAvailability,
  defaultAvailabilityCtx,
  evaluateConnectorPaths,
  getFamilies,
  resolveDeepLink,
} from "./connector-paths.mjs";
import {
  isSecretEnvName,
  maskTail,
  PATH_PROBES,
  probeConnectorPath,
  redactSecrets,
  registerRedactionEnv,
} from "./credential-probes.mjs";
import { HOME_ENV_PATH, loadLayeredEnv, writeSecret } from "./env-layers.mjs";
import {
  freshness,
  LEDGER_PATH,
  readLedger,
  recordOutcomes,
} from "./hitl-ledger.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const REPO_ENV_PATH = join(ROOT, ".env");
const PROBE_CACHE_PATH = join(
  ROOT,
  "reports/lifeops-live-validation/11632-status/path-probes.json",
);
const HOST = "127.0.0.1";
const BASE_PORT = 43117;
const MAX_PORT_PROBES = 50;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 4096;
const DASHBOARD_LANE = "dashboard-probe";
const DASHBOARD_SESSION_TOKEN = randomBytes(32).toString("base64url");
const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);
let dashboardOrigin = null;

const FAMILY_LABELS = {
  model: "Model providers",
  elizacloud: "Eliza Cloud",
  github: "GitHub",
  google: "Google Calendar / Gmail",
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  signal: "Signal",
  whatsapp: "WhatsApp",
  imessage: "iMessage",
  x: "X",
  twilio: "Phone / SMS / Voice (Twilio)",
  health: "Health",
  finance: "Finances",
  crypto: "Crypto wallets",
};

{
  const unlabeled = getFamilies().filter(
    (family) => !(family in FAMILY_LABELS),
  );
  if (unlabeled.length > 0) {
    throw new Error(
      `[hitl-dashboard] FAMILY_LABELS missing entries for: ${unlabeled.join(", ")}`,
    );
  }
}

// Spellings that must stay in sync: the WhatsApp connector reads ELIZA_* while
// the Graph tooling reads bare names; the cloud SDK accepts either cloud-key
// spelling and probes prefer ELIZAOS_*.
const WRITE_ALIASES = {
  ELIZA_WHATSAPP_ACCESS_TOKEN: ["WHATSAPP_ACCESS_TOKEN"],
  WHATSAPP_ACCESS_TOKEN: ["ELIZA_WHATSAPP_ACCESS_TOKEN"],
  ELIZA_WHATSAPP_PHONE_NUMBER_ID: ["WHATSAPP_PHONE_NUMBER_ID"],
  WHATSAPP_PHONE_NUMBER_ID: ["ELIZA_WHATSAPP_PHONE_NUMBER_ID"],
  ELIZAOS_CLOUD_API_KEY: ["ELIZA_CLOUD_API_KEY"],
  ELIZA_CLOUD_API_KEY: ["ELIZAOS_CLOUD_API_KEY"],
};

// GitHub slots the gh-CLI one-click may fill: legacy single token or the
// OWNER/AGENT PAT slots from plugins/plugin-github/src/accounts.ts.
const GH_TOKEN_SLOTS = new Set([
  "GITHUB_TOKEN",
  "GITHUB_USER_PAT",
  "GITHUB_AGENT_PAT",
]);

function resolveCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "[hitl-dashboard] git rev-parse HEAD failed — ledger outcomes must record the commit they ran at",
    );
  }
  return result.stdout.trim();
}

const COMMIT = resolveCommit();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || actual.length === 0) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function assertDashboardPost(req) {
  const remoteAddress = req.socket?.remoteAddress;
  if (remoteAddress && !LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress)) {
    throw new HttpError(403, "dashboard POSTs are loopback-only");
  }
  if (!dashboardOrigin) {
    throw new HttpError(503, "dashboard origin is not ready");
  }
  if (req.headers.origin !== dashboardOrigin) {
    throw new HttpError(403, "dashboard POST rejected: origin mismatch");
  }
  const contentType = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    throw new HttpError(415, "dashboard POSTs must use application/json");
  }
  if (!tokenMatches(req.headers["x-hitl-session"], DASHBOARD_SESSION_TOKEN)) {
    throw new HttpError(403, "dashboard POST rejected: invalid session");
  }
}

// --- per-path probe cache ------------------------------------------------------

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function loadProbeCache() {
  if (!existsSync(PROBE_CACHE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PROBE_CACHE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    // error-policy:J3 the cache is regenerable operator state; a corrupt file is explicitly discarded and rebuilt by the next probe.
    console.warn(
      `[hitl-dashboard] discarding unreadable probe cache at ${PROBE_CACHE_PATH}`,
    );
    return {};
  }
}

const probeCache = loadProbeCache();

function rememberProbes(results) {
  for (const result of results) probeCache[result.pathId] = result;
  atomicWrite(PROBE_CACHE_PATH, `${JSON.stringify(probeCache, null, 2)}\n`);
}

// --- env saves (layered, never via process.env) ---------------------------------

// writeSecret mirrors writes into the processEnv it is handed; giving it a
// scratch object keeps the real process.env pristine so the per-layer source
// badges stay truthful — probes read the merged layered env instead.
const SAVE_SCRATCH_ENV = {};

function parseTarget(body) {
  const target = body?.target ?? "home";
  if (target !== "home" && target !== "repo") {
    throw new HttpError(
      400,
      'target must be "home" (~/.eliza/.env, default) or "repo"',
    );
  }
  return target;
}

function persistEnvVar(key, value, target) {
  if (typeof key !== "string" || !CONNECTOR_PATH_ENV_NAMES.has(key)) {
    throw new HttpError(
      400,
      `unknown env name${typeof key === "string" ? `: ${key}` : ""} — only credential names from the CONNECTOR_PATHS registry are writable`,
    );
  }
  if (typeof value !== "string")
    throw new HttpError(400, "value must be a string");
  if (value.length > MAX_VALUE_CHARS) {
    throw new HttpError(400, `value exceeds ${MAX_VALUE_CHARS} chars`);
  }
  if (/[\r\n]/.test(value))
    throw new HttpError(400, "value must not contain newlines");
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new HttpError(400, "value is empty");
  const aliases = WRITE_ALIASES[key] ?? [];
  const paths = new Set();
  for (const name of [key, ...aliases]) {
    const saved = writeSecret(name, trimmed, {
      scope: target,
      processEnv: SAVE_SCRATCH_ENV,
    });
    paths.add(saved.path);
  }
  registerRedactionEnv({ [key]: trimmed });
  console.log(
    `[hitl-dashboard] saved ${key}${aliases.length > 0 ? ` (+ ${aliases.join(", ")})` : ""} -> ${target} (${maskTail(trimmed)})`,
  );
  return {
    key,
    masked: maskTail(trimmed),
    alsoWrote: aliases,
    target,
    paths: [...paths],
  };
}

// --- status assembly (server computes, client displays) --------------------------

function presenceField(name, tag, layered) {
  const value = layered.values[name];
  const present = typeof value === "string" && value.trim().length > 0;
  return {
    name,
    tag,
    secret: isSecretEnvName(name),
    present,
    masked: present ? maskTail(value.trim()) : null,
    source: layered.sources[name] ?? null,
  };
}

function pathFields(row, layered) {
  const slotNames = new Set([...row.ownerVars, ...row.agentVars]);
  const fields = [];
  const seen = new Set();
  const add = (names, tag) => {
    for (const name of names) {
      if (seen.has(name) || slotNames.has(name)) continue;
      seen.add(name);
      fields.push(presenceField(name, tag, layered));
    }
  };
  add(row.requiredAll, "required");
  add(row.requiredAny, "any-of");
  add(row.optional, "optional");
  return fields;
}

function identitySlot(label, tag, vars, layered) {
  if (vars.length === 0) return null;
  const fields = vars.map((name) => presenceField(name, tag, layered));
  return { label, fields, present: fields.some((field) => field.present) };
}

function pathState(row, fields, slots, probe) {
  if (!row.available) return "skip";
  if (probe && probe.ok === true) return "green";
  if (probe && probe.ok === false) return "red";
  const slotFields = slots.flatMap((slot) => slot?.fields ?? []);
  if ([...fields, ...slotFields].some((field) => field.present))
    return "yellow";
  // Env-less local bridges (Signal Desktop, macOS Messages) are "present" the
  // moment their availability check passes — there is nothing to paste.
  if (fields.length === 0 && slotFields.length === 0) return "yellow";
  return "gray";
}

function familyState(paths) {
  if (paths.some((path) => path.state === "green")) return "green";
  if (paths.some((path) => path.state === "red")) return "red";
  if (paths.some((path) => path.state === "yellow")) return "yellow";
  return "gray";
}

function buildStatusPayload() {
  const layered = loadLayeredEnv();
  const ctx = { ...defaultAvailabilityCtx(), env: layered.values };
  const rows = evaluateConnectorPaths(ctx);
  const ledger = readLedger();
  const byFamily = new Map();
  for (const row of rows) {
    const fields = pathFields(row, layered);
    const ownerSlot = identitySlot(
      "OWNER account",
      "owner",
      row.ownerVars,
      layered,
    );
    const agentSlot = identitySlot(
      "AGENT account",
      "agent",
      row.agentVars,
      layered,
    );
    const probe = probeCache[row.id] ?? null;
    const entry = ledger.entries[row.id];
    const lastSuccessAt = entry?.lastSuccessAt ?? null;
    const path = {
      id: row.id,
      kind: row.kind,
      label: row.label,
      rolesVia: row.rolesVia,
      available: row.available,
      skipReason: row.available ? null : row.reason,
      probeWired: row.id in PATH_PROBES,
      probeEndpoint: row.probeEndpoint,
      oneClick: row.oneClick
        ? { ...row.oneClick, href: resolveDeepLink(row, layered.values) }
        : null,
      notes: row.notes,
      fields,
      ownerSlot,
      agentSlot,
      probe,
      freshness: {
        ...freshness(lastSuccessAt),
        lastSuccessAt,
        lastRunAt: entry?.lastRunAt ?? null,
      },
      state: pathState(row, fields, [ownerSlot, agentSlot], probe),
    };
    if (!byFamily.has(row.family)) byFamily.set(row.family, []);
    byFamily.get(row.family).push(path);
  }
  const families = [...byFamily.entries()].map(([id, paths]) => ({
    id,
    label: FAMILY_LABELS[id],
    state: familyState(paths),
    paths,
  }));
  const base = appBase(layered.values);
  return {
    generatedAt: new Date().toISOString(),
    commit: COMMIT,
    envLayers: layered.layers,
    saveTargets: { home: HOME_ENV_PATH, repo: REPO_ENV_PATH },
    ledgerPath: LEDGER_PATH,
    probeCachePath: PROBE_CACHE_PATH,
    appLinks: {
      connectors: `${base}/settings?section=connectors`,
      secrets: `${base}/settings?section=secrets`,
      liveTest: `${base}/lifeops-live-test`,
    },
    families,
  };
}

// --- probes ----------------------------------------------------------------------

function pathById(pathId) {
  const row = CONNECTOR_PATHS.find((path) => path.id === pathId);
  if (!row) throw new HttpError(404, `unknown auth path: ${pathId}`);
  return row;
}

async function probePath(pathId, layered, ctx) {
  const row = pathById(pathId);
  const availability = checkAvailability(row.availability, ctx);
  const probedAt = new Date().toISOString();
  if (!availability.available) {
    return {
      pathId,
      family: row.family,
      ok: null,
      skip: availability.reason,
      probedAt,
    };
  }
  if (!(pathId in PATH_PROBES)) {
    return {
      pathId,
      family: row.family,
      ok: null,
      skip: `no wired probe — documented check: ${row.probeEndpoint}`,
      probedAt,
    };
  }
  return probeConnectorPath(pathId, layered.values);
}

function ledgerOutcome(result) {
  return {
    pathId: result.pathId,
    ok: result.ok,
    at: result.probedAt,
    lane: DASHBOARD_LANE,
    commit: COMMIT,
    counts: {
      passed: result.ok === true ? 1 : 0,
      failed: result.ok === false ? 1 : 0,
      skipped: result.ok === null ? 1 : 0,
    },
  };
}

async function runPathProbes(pathIds) {
  const layered = loadLayeredEnv();
  const ctx = { ...defaultAvailabilityCtx(), env: layered.values };
  const results = await Promise.all(
    pathIds.map((pathId) => probePath(pathId, layered, ctx)),
  );
  rememberProbes(results);
  recordOutcomes(results.map(ledgerOutcome));
  for (const result of results) {
    const verdict =
      result.ok === true ? "ok" : result.ok === false ? "FAIL" : "skip";
    console.log(
      `[hitl-dashboard] probe ${result.pathId}: ${verdict} — ${result.detail ?? result.skip}`,
    );
  }
  return results;
}

// --- one-click acquisitions --------------------------------------------------------

function runCommand(
  command,
  args,
  { timeoutMs = 30_000, env = process.env, cwd = ROOT } = {},
) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        status: null,
        stdout,
        stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`,
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ status: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      finish({ status, stdout, stderr });
    });
  });
}

async function handleGhToken(body) {
  const key = body?.key ?? "GITHUB_TOKEN";
  if (!GH_TOKEN_SLOTS.has(key)) {
    throw new HttpError(
      400,
      `key must be one of ${[...GH_TOKEN_SLOTS].join(", ")}`,
    );
  }
  const target = parseTarget(body);
  const run = await runCommand("gh", ["auth", "token"], { timeoutMs: 15_000 });
  if (run.status !== 0) {
    throw new HttpError(
      502,
      `gh auth token failed: ${run.stderr.trim().slice(0, 200) || `status ${run.status}`}`,
    );
  }
  const token = run.stdout.trim();
  if (!/^\S{20,}$/.test(token)) {
    throw new HttpError(502, "gh auth token returned no usable token");
  }
  return { ...persistEnvVar(key, token, target), source: "gh CLI keyring" };
}

async function handleSiweLogin(body) {
  const target = parseTarget(body);
  const layered = loadLayeredEnv();
  // The SIWE script honors PRIVATE_KEY (pin wallet) and SIWE_BASE (API base);
  // surface file-layer values to the child without mutating our own env.
  const childEnv = { ...process.env };
  for (const name of ["PRIVATE_KEY", "SIWE_BASE"]) {
    if (
      childEnv[name] === undefined &&
      typeof layered.values[name] === "string"
    ) {
      childEnv[name] = layered.values[name];
    }
  }
  const run = await runCommand(
    "bun",
    ["scripts/cloud/siwe-test-login.mjs", "--json"],
    {
      timeoutMs: 90_000,
      env: childEnv,
    },
  );
  const jsonLine = run.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("{"));
  if (run.status !== 0 || !jsonLine) {
    throw new HttpError(
      502,
      `SIWE login failed: ${(run.stderr || run.stdout).trim().slice(-300) || "no output"} — fallback: paste an API key into ELIZAOS_CLOUD_API_KEY`,
    );
  }
  let session;
  try {
    session = JSON.parse(jsonLine);
  } catch {
    // error-policy:J3 child stdout is untrusted input; unparseable JSON is an explicit 502, never a defaulted session.
    throw new HttpError(502, "SIWE login emitted unparseable JSON");
  }
  if (typeof session.apiKey !== "string" || session.apiKey.length < 8) {
    throw new HttpError(502, "SIWE login returned no apiKey");
  }
  const saved = persistEnvVar("ELIZAOS_CLOUD_API_KEY", session.apiKey, target);
  return {
    ...saved,
    address: session.address,
    isNewAccount: session.isNewAccount,
    baseUrl: session.baseUrl,
    balance: session.balance,
    balanceStatus: session.balanceStatus,
  };
}

// signal-cli link prints the pairing URI within seconds, then must stay alive
// for the phone scan to complete — so this resolves on the URI and leaves the
// child running inside a bounded scan window.
const SIGNAL_LINK_URI_WAIT_MS = 20_000;
const SIGNAL_LINK_SCAN_WINDOW_MS = 180_000;

function handleSignalLink() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("signal-cli", ["link", "-n", "eliza-hitl-dashboard"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(uriTimer);
      fn(value);
    };
    const uriTimer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(
        rejectPromise,
        new HttpError(
          502,
          `signal-cli link emitted no URI within ${SIGNAL_LINK_URI_WAIT_MS / 1000}s: ${output.trim().slice(-300)}`,
        ),
      );
    }, SIGNAL_LINK_URI_WAIT_MS);
    const scanWindow = setTimeout(
      () => child.kill("SIGKILL"),
      SIGNAL_LINK_SCAN_WINDOW_MS,
    );
    scanWindow.unref();
    const onData = (chunk) => {
      output += chunk;
      const match = /(sgnl:\/\/linkdevice\S+)/.exec(output);
      if (match) {
        settle(resolvePromise, {
          ok: true,
          uri: match[1],
          note: `scan from the phone (Signal → Settings → Linked devices → Link new device); pairing window stays open ${SIGNAL_LINK_SCAN_WINDOW_MS / 60_000} minutes`,
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      settle(
        rejectPromise,
        new HttpError(502, `signal-cli spawn failed: ${error.message}`),
      );
    });
    child.on("close", (status) => {
      settle(
        rejectPromise,
        new HttpError(
          502,
          `signal-cli link exited (status ${status}) before emitting a URI: ${output.trim().slice(-300)}`,
        ),
      );
    });
  });
}

// --- HTTP plumbing -------------------------------------------------------------------

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // error-policy:J3 request bodies are untrusted input; unparseable JSON is an explicit 400, never a defaulted object.
    throw new HttpError(400, "invalid JSON body");
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  if (req.method === "POST") assertDashboardPost(req);
  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(PAGE_HTML);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, buildStatusPayload());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/env") {
    const body = await readJsonBody(req);
    sendJson(
      res,
      200,
      persistEnvVar(body?.key, body?.value, parseTarget(body)),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/probe-all") {
    const pathIds = CONNECTOR_PATHS.map((path) => path.id);
    sendJson(res, 200, { results: await runPathProbes(pathIds) });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/probe/")) {
    const pathId = decodeURIComponent(url.pathname.slice("/api/probe/".length));
    pathById(pathId);
    sendJson(res, 200, { results: await runPathProbes([pathId]) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/oneclick/gh-token") {
    sendJson(res, 200, await handleGhToken(await readJsonBody(req)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/oneclick/siwe") {
    sendJson(res, 200, await handleSiweLogin(await readJsonBody(req)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/oneclick/signal-link") {
    sendJson(res, 200, await handleSignalLink());
    return;
  }
  throw new HttpError(404, `no route: ${req.method} ${url.pathname}`);
}

// --- inline page -----------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LifeOps HITL Credentials v2 (#11632)</title>
<style>
  :root {
    --bg: #101014; --panel: #17171b; --panel-2: #1e1e24; --border: #2a2a31;
    --text: #e8e6e3; --dim: #9a97a0; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --accent: #ff5800; --accent-hover: #d94b00;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --gray: #6e7681;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  a { color: var(--accent); }
  a:hover { color: var(--accent-hover); }
  header { padding: 16px 22px 12px; border-bottom: 1px solid var(--border); display: grid; gap: 8px; }
  .head-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: 0.02em; }
  header .sub { color: var(--dim); font-size: 12px; }
  .spacer { flex: 1; }
  .links { display: flex; gap: 14px; font-size: 12px; }
  .layers { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; font-family: var(--mono); color: var(--dim); }
  .layer { border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; }
  .layer b { color: var(--text); font-weight: 600; }
  .layer.absent { opacity: 0.55; }
  .target-toggle { display: flex; gap: 10px; font-size: 12px; color: var(--dim); align-items: center; }
  .target-toggle label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
  main { max-width: 1160px; margin: 0 auto; padding: 20px 22px 60px; display: grid; gap: 16px; }
  .family { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .family-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .family-head h2 { font-size: 14px; margin: 0; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.green { background: var(--green); } .dot.red { background: var(--red); }
  .dot.yellow { background: var(--yellow); } .dot.gray, .dot.skip { background: var(--gray); }
  .state-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
  .path { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-top: 8px; background: var(--panel-2); }
  .path.skip { opacity: 0.75; }
  .path-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .path-head h3 { font-size: 13px; margin: 0; font-weight: 600; }
  .chip { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; }
  .chip.fresh-green { color: var(--green); border-color: var(--green); }
  .chip.fresh-yellow { color: var(--yellow); border-color: var(--yellow); }
  .chip.fresh-red { color: var(--red); border-color: var(--red); }
  .skip-reason { margin: 6px 0 0; font-size: 12px; color: var(--gray); font-style: italic; }
  .probe-detail { margin: 6px 0 0; font-size: 12px; color: var(--dim); }
  .probe-detail .ok { color: var(--green); } .probe-detail .fail { color: var(--red); }
  .probe-detail .skipped { color: var(--gray); }
  .notes { margin: 6px 0 0; font-size: 11px; color: var(--dim); }
  .uri-box { margin: 8px 0 0; font-family: var(--mono); font-size: 11px; word-break: break-all; background: #0c0c0f; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
  .slots { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
  .slot { flex: 1; min-width: 320px; border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; }
  .slot-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); margin: 0 0 6px; }
  .fields { margin-top: 8px; display: grid; gap: 6px; }
  .field { display: grid; grid-template-columns: minmax(190px, 1.1fr) 62px 58px 84px minmax(150px, 1.4fr) auto; gap: 8px; align-items: center; }
  .field .name { font-family: var(--mono); font-size: 12px; word-break: break-all; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; text-align: center; }
  .tag.required { color: var(--accent); border-color: var(--accent); }
  .tag.owner, .tag.agent { color: var(--text); border-color: var(--dim); }
  .src { font-size: 10px; font-family: var(--mono); color: var(--dim); text-align: center; border: 1px solid transparent; }
  .src.set { color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; }
  .masked { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .masked.set { color: var(--text); }
  input[type="text"], input[type="password"] {
    width: 100%; background: #0c0c0f; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 5px 8px; font-family: var(--mono); font-size: 12px;
    caret-color: var(--accent); accent-color: var(--accent);
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(255, 88, 0, 0.25); }
  input[type="radio"] { accent-color: var(--accent); }
  button { border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); padding: 5px 11px; font-size: 12px; cursor: pointer; }
  button:hover { background: rgba(232, 230, 227, 0.12); }
  button:disabled { opacity: 0.5; cursor: wait; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #14100c; font-weight: 600; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  a.btn { display: inline-block; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); padding: 5px 11px; font-size: 12px; text-decoration: none; }
  a.btn:hover { background: rgba(232, 230, 227, 0.12); color: var(--text); }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 14px; font-size: 12px; max-width: 460px; display: none; z-index: 10; }
  .toast.error { border-left-color: var(--red); }
  .meta { font-size: 11px; color: var(--dim); font-family: var(--mono); }
</style>
</head>
<body>
<header>
  <div class="head-row">
    <h1>LifeOps HITL credential intake — v2</h1>
    <span class="sub">#11632 · per auth path · values masked to last 4 · saves default to ~/.eliza/.env</span>
    <span class="spacer"></span>
    <nav class="links" id="app-links"></nav>
    <button class="primary" id="probe-all">Probe all paths</button>
  </div>
  <div class="layers" id="env-layers"></div>
  <div class="head-row">
    <div class="target-toggle" id="target-toggle">
      <span>save target:</span>
      <label><input type="radio" name="save-target" value="home" checked> <span id="home-path">~/.eliza/.env</span></label>
      <label><input type="radio" name="save-target" value="repo"> <span id="repo-path">repo .env</span></label>
    </div>
    <span class="spacer"></span>
    <span class="meta" id="ledger-meta"></span>
  </div>
</header>
<main id="families"><p class="meta">loading…</p></main>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var SESSION_TOKEN = ${JSON.stringify(DASHBOARD_SESSION_TOKEN)};
  var toastTimer = null;
  function toast(message, isError) {
    var node = document.getElementById('toast');
    node.textContent = message;
    node.className = isError ? 'toast error' : 'toast';
    node.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.style.display = 'none'; }, 6000);
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function api(method, path, body) {
    var options = { method: method };
    if (method !== 'GET') {
      options.headers = {
        'Content-Type': 'application/json',
        'X-HITL-Session': SESSION_TOKEN,
      };
      options.body = JSON.stringify(body || {});
    }
    return fetch(path, options).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
        return payload;
      });
    });
  }
  function saveTarget() {
    var checked = document.querySelector('input[name="save-target"]:checked');
    return checked ? checked.value : 'home';
  }
  function stateLabel(state) {
    if (state === 'green') return 'probe ok';
    if (state === 'red') return 'probe failed';
    if (state === 'yellow') return 'present — unprobed';
    if (state === 'skip') return 'unavailable';
    return 'missing';
  }
  function renderLinks(links) {
    var nav = document.getElementById('app-links');
    nav.textContent = '';
    [['Settings → Connectors', links.connectors],
     ['Settings → Secrets', links.secrets],
     ['Live-test view', links.liveTest]].forEach(function (item) {
      var a = el('a', null, item[0]);
      a.href = item[1]; a.target = '_blank'; a.rel = 'noreferrer';
      nav.appendChild(a);
    });
  }
  function renderLayers(layers) {
    var box = document.getElementById('env-layers');
    box.textContent = '';
    box.appendChild(el('span', null, 'env layers (highest wins):'));
    layers.forEach(function (layer) {
      var chip = el('span', 'layer' + (layer.exists ? '' : ' absent'));
      chip.appendChild(el('b', null, layer.source));
      chip.appendChild(document.createTextNode(' ' + (layer.path || 'process.env') + (layer.exists ? '' : ' (absent)')));
      box.appendChild(chip);
    });
  }
  function busyRun(button, busyText, promise) {
    var original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    return promise
      .catch(function (error) { toast(String(error.message || error), true); })
      .then(function (value) {
        button.disabled = false;
        button.textContent = original;
        return refresh().then(function () { return value; });
      });
  }
  function probeButton(path) {
    var button = el('button', null, 'Probe');
    button.title = path.probeEndpoint;
    button.addEventListener('click', function () {
      busyRun(button, 'probing…', api('POST', '/api/probe/' + encodeURIComponent(path.id)).then(function (payload) {
        var result = payload.results[0];
        var verdict = result.ok === true ? 'ok — ' : result.ok === false ? 'FAILED — ' : 'SKIP — ';
        toast(result.pathId + ': ' + verdict + (result.detail || result.skip), result.ok === false);
      }));
    });
    return button;
  }
  function oneClickControls(path, card) {
    var controls = [];
    var oc = path.oneClick;
    if (oc && oc.type === 'gh-token') {
      var gh = el('button', null, 'Use gh CLI token');
      gh.title = oc.detail;
      gh.addEventListener('click', function () {
        busyRun(gh, 'fetching…', api('POST', '/api/oneclick/gh-token', { target: saveTarget() }).then(function (payload) {
          toast('saved ' + payload.key + ' = ' + payload.masked + ' from ' + payload.source + ' → ' + payload.target, false);
        }));
      });
      controls.push(gh);
    }
    if (oc && oc.type === 'siwe') {
      var siwe = el('button', null, 'Login with Eliza Cloud');
      siwe.title = oc.detail;
      siwe.addEventListener('click', function () {
        busyRun(siwe, 'signing in…', api('POST', '/api/oneclick/siwe', { target: saveTarget() }).then(function (payload) {
          toast('cloud login ok: ' + payload.address + ' · saved ' + payload.key + ' = ' + payload.masked + ' → ' + payload.target, false);
        }));
      });
      controls.push(siwe);
    }
    if (oc && oc.type === 'shell' && path.id === 'signal.cli') {
      var link = el('button', null, 'Link via signal-cli');
      link.title = oc.detail;
      link.addEventListener('click', function () {
        busyRun(link, 'linking…', api('POST', '/api/oneclick/signal-link').then(function (payload) {
          var box = el('p', 'uri-box', payload.uri + ' — ' + payload.note);
          card.appendChild(box);
          toast('link URI emitted — scan it from the phone', false);
        }));
      });
      controls.push(link);
    }
    if (oc && oc.type === 'deep-link' && oc.href) {
      var a = el('a', 'btn', 'Open app settings');
      a.href = oc.href; a.target = '_blank'; a.rel = 'noreferrer';
      a.title = oc.detail;
      controls.push(a);
    }
    if (path.kind === 'local-bridge') {
      var recheck = el('button', null, 'Re-check');
      recheck.title = 'Re-evaluate local availability (installs, bridges, file access)';
      recheck.addEventListener('click', function () {
        busyRun(recheck, 'checking…', Promise.resolve().then(function () {
          toast('availability re-checked', false);
        }));
      });
      controls.push(recheck);
    }
    return controls;
  }
  function fieldRow(field) {
    var row = el('div', 'field');
    row.appendChild(el('span', 'name', field.name));
    row.appendChild(el('span', 'tag ' + field.tag, field.tag));
    row.appendChild(el('span', 'src' + (field.source ? ' set' : ''), field.source || '—'));
    row.appendChild(el('span', 'masked' + (field.present ? ' set' : ''), field.present ? field.masked : '—'));
    var input = document.createElement('input');
    input.type = field.secret ? 'password' : 'text';
    input.placeholder = field.present ? 'replace value…' : 'paste value…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.appendChild(input);
    var save = el('button', null, 'Save');
    function submit() {
      if (input.value.trim().length === 0) { toast('nothing to save for ' + field.name, true); return; }
      busyRun(save, 'saving…', api('POST', '/api/env', { key: field.name, value: input.value, target: saveTarget() }).then(function (payload) {
        var extra = payload.alsoWrote.length > 0 ? ' (also wrote ' + payload.alsoWrote.join(', ') + ')' : '';
        toast('saved ' + payload.key + ' = ' + payload.masked + ' → ' + payload.target + extra, false);
      }));
    }
    save.addEventListener('click', submit);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });
    row.appendChild(save);
    return row;
  }
  function renderSlot(slot) {
    var box = el('div', 'slot');
    box.appendChild(el('p', 'slot-title', slot.label));
    slot.fields.forEach(function (field) { box.appendChild(fieldRow(field)); });
    return box;
  }
  function renderPath(path) {
    var card = el('div', 'path' + (path.state === 'skip' ? ' skip' : ''));
    var head = el('div', 'path-head');
    head.appendChild(el('span', 'dot ' + path.state));
    head.appendChild(el('h3', null, path.label));
    head.appendChild(el('span', 'chip', path.kind));
    var fresh = el('span', 'chip fresh-' + path.freshness.state, path.freshness.label);
    fresh.title = 'lastSuccessAt: ' + (path.freshness.lastSuccessAt || 'never') + ' · lastRunAt: ' + (path.freshness.lastRunAt || 'never');
    head.appendChild(fresh);
    head.appendChild(el('span', 'state-label', stateLabel(path.state)));
    head.appendChild(el('span', 'spacer'));
    oneClickControls(path, card).forEach(function (control) { head.appendChild(control); });
    if (path.probeWired && path.available) head.appendChild(probeButton(path));
    card.appendChild(head);
    if (path.skipReason) card.appendChild(el('p', 'skip-reason', 'SKIP — ' + path.skipReason));
    if (path.probe) {
      var line = el('p', 'probe-detail');
      if (path.probe.ok === true) line.appendChild(el('span', 'ok', '● ok '));
      else if (path.probe.ok === false) line.appendChild(el('span', 'fail', '● failed '));
      else line.appendChild(el('span', 'skipped', '● skipped '));
      line.appendChild(el('span', null, (path.probe.detail || path.probe.skip) + ' (' + path.probe.probedAt + ')'));
      card.appendChild(line);
    }
    if (path.ownerSlot || path.agentSlot) {
      var slots = el('div', 'slots');
      if (path.ownerSlot) slots.appendChild(renderSlot(path.ownerSlot));
      if (path.agentSlot) slots.appendChild(renderSlot(path.agentSlot));
      card.appendChild(slots);
    }
    if (path.fields.length > 0) {
      var fields = el('div', 'fields');
      path.fields.forEach(function (field) { fields.appendChild(fieldRow(field)); });
      card.appendChild(fields);
    }
    if (path.notes) card.appendChild(el('p', 'notes', path.notes));
    return card;
  }
  function renderFamily(family) {
    var section = el('section', 'family');
    var head = el('div', 'family-head');
    head.appendChild(el('span', 'dot ' + family.state));
    head.appendChild(el('h2', null, family.label));
    head.appendChild(el('span', 'state-label', stateLabel(family.state)));
    section.appendChild(head);
    family.paths.forEach(function (path) { section.appendChild(renderPath(path)); });
    return section;
  }
  function refresh() {
    return api('GET', '/api/status').then(function (status) {
      renderLinks(status.appLinks);
      renderLayers(status.envLayers);
      document.getElementById('home-path').textContent = status.saveTargets.home;
      document.getElementById('repo-path').textContent = 'repo ' + status.saveTargets.repo;
      document.getElementById('ledger-meta').textContent = 'ledger: ' + status.ledgerPath + ' · commit ' + status.commit;
      var main = document.getElementById('families');
      main.textContent = '';
      status.families.forEach(function (family) { main.appendChild(renderFamily(family)); });
      main.appendChild(el('p', 'meta', 'probe cache: ' + status.probeCachePath + ' · ' + status.generatedAt));
    });
  }
  document.getElementById('probe-all').addEventListener('click', function () {
    var button = document.getElementById('probe-all');
    busyRun(button, 'probing all…', api('POST', '/api/probe-all').then(function (payload) {
      var ok = 0, failed = 0, skipped = 0;
      payload.results.forEach(function (result) {
        if (result.ok === true) ok += 1;
        else if (result.ok === false) failed += 1;
        else skipped += 1;
      });
      toast('probe-all done: ' + ok + ' ok · ' + failed + ' failed · ' + skipped + ' skipped', failed > 0);
    }));
  });
  refresh().catch(function (error) { toast(String(error.message || error), true); });
})();
</script>
</body>
</html>
`;

// --- boot ------------------------------------------------------------------------------

function listenOnFreePort(server) {
  return new Promise((resolvePromise, reject) => {
    let port = BASE_PORT;
    const tryListen = () => {
      const onError = (error) => {
        // Port probing is the designed behavior: walk up from BASE_PORT until
        // a loopback port is free, so parallel worktree lanes never collide.
        if (
          (error.code === "EADDRINUSE" || error.code === "EACCES") &&
          port < BASE_PORT + MAX_PORT_PROBES
        ) {
          port += 1;
          tryListen();
          return;
        }
        reject(error);
      };
      server.once("error", onError);
      server.listen(port, HOST, () => {
        server.removeListener("error", onError);
        resolvePromise(port);
      });
    };
    tryListen();
  });
}

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      // error-policy:J1 transport boundary — every route failure becomes a structured JSON error response.
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(res, status, {
        error: redactSecrets(String(error?.message ?? error)),
      });
    });
  });
  const port = await listenOnFreePort(server);
  const address = `http://${HOST}:${port}/`;
  dashboardOrigin = new URL(address).origin;
  const { layers } = loadLayeredEnv();
  console.log(`[hitl-dashboard] v2 listening on ${address} (commit ${COMMIT})`);
  for (const layer of layers) {
    console.log(
      `[hitl-dashboard] env layer ${layer.source.padEnd(8)} ${layer.path ?? "(process.env)"}${layer.exists ? "" : " (absent)"}`,
    );
  }
  console.log(`[hitl-dashboard] ledger: ${LEDGER_PATH}`);
  console.log(
    `[hitl-dashboard] probe cache: ${PROBE_CACHE_PATH} (${Object.keys(probeCache).length} cached)`,
  );
  if (process.argv.includes("--open")) {
    spawn("open", [address], { stdio: "ignore", detached: true }).unref();
  }
  const shutdown = () => {
    console.log("[hitl-dashboard] shutting down");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
