#!/usr/bin/env node
/**
 * HITL credential intake dashboard for the LifeOps live-validation run
 * (#11632): a loopback-only page where the operator pastes connector secrets,
 * watches per-family readiness (gray missing / yellow present-unprobed /
 * green probe-ok / red probe-failed), and fires the live probes from
 * scripts/lifeops/credential-probes.mjs. Secrets never leave the machine and
 * are never echoed — the API returns only last-4 masks, and probe details are
 * redacted upstream.
 *
 * Zero dependencies: node:http on 127.0.0.1 (first free port from 43117),
 * one inline HTML page, connector rows driven by CONNECTOR_GROUPS from
 * collect-11632-live-validation-status.mjs. Saves upsert the worktree .env
 * atomically (tmp + rename, mode 600); probe results are cached under
 * reports/lifeops-live-validation/11632-status/probes.json so a restart keeps
 * the last verdicts. OAuth-only families (Google, Health wearables) link out
 * to the running app's Settings → Connectors / Secrets pages, where the real
 * consent flow lives. Run: bun run lifeops:hitl (add --open to launch the
 * macOS browser).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import {
  CONNECTOR_GROUPS,
  groupStatus,
} from "./collect-11632-live-validation-status.mjs";
import {
  isSecretEnvName,
  maskTail,
  PROBE_FAMILIES,
  probeAll,
  redactSecrets,
} from "./credential-probes.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const ENV_PATH = join(ROOT, ".env");
const PROBE_CACHE_PATH = join(
  ROOT,
  "reports/lifeops-live-validation/11632-status/probes.json",
);
const HOST = "127.0.0.1";
const BASE_PORT = 43117;
const MAX_PORT_PROBES = 50;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 4096;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator-run intake tool outside Turbo tasks, matching the collector's device-probe precedent.
const APP_BASE = process.env.ELIZA_APP_BASE_URL ?? "http://localhost:2138";

// Env names the intake UI may write beyond what CONNECTOR_GROUPS lists —
// each one is required by a probe (X OAuth1 signing, Telegram send target,
// Twilio outbound number, Slack user-context calls, WhatsApp runtime names).
const EXTRA_FIELDS_BY_GROUP = {
  x: [
    "TWITTER_API_SECRET_KEY",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_TOKEN_SECRET",
  ],
  telegram: ["TELEGRAM_TEST_CHAT_ID"],
  twilio: ["TWILIO_PHONE_NUMBER"],
  slack: ["SLACK_USER_TOKEN"],
  whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
};

// The WhatsApp connector reads ELIZA_WHATSAPP_* while the Graph tooling reads
// the bare names; a save to either spelling keeps both in sync.
const WRITE_ALIASES = {
  ELIZA_WHATSAPP_ACCESS_TOKEN: ["WHATSAPP_ACCESS_TOKEN"],
  WHATSAPP_ACCESS_TOKEN: ["ELIZA_WHATSAPP_ACCESS_TOKEN"],
  ELIZA_WHATSAPP_PHONE_NUMBER_ID: ["WHATSAPP_PHONE_NUMBER_ID"],
  WHATSAPP_PHONE_NUMBER_ID: ["ELIZA_WHATSAPP_PHONE_NUMBER_ID"],
};

const GROUP_PROBE_FAMILIES = {
  model: ["model"],
  google: ["google"],
  discord: ["discord"],
  telegram: ["telegram"],
  slack: ["slack"],
  signal: ["signal"],
  whatsapp: ["whatsapp"],
  x: ["x"],
  twilio: ["twilio"],
  health: ["health"],
  finance: ["plaid", "paypal"],
  native_ios_macos: [],
  native_android: [],
};

// Families whose real validation is an in-app OAuth consent flow, not a
// pasted token: the dashboard links them to the running app instead.
const OAUTH_GROUPS = new Set(["google", "health"]);

const KNOWN_ENV_NAMES = new Set([
  ...CONNECTOR_GROUPS.flatMap((group) => [
    ...(group.requiredAll ?? []),
    ...(group.requiredAny ?? []),
    ...(group.optional ?? []),
  ]),
  ...Object.values(EXTRA_FIELDS_BY_GROUP).flat(),
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- .env handling ----------------------------------------------------------

function parseDotenv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      trimmed,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** dotenv semantics with override:false — existing process.env always wins. */
function loadDotenv() {
  if (!existsSync(ENV_PATH)) return;
  const parsed = parseDotenv(readFileSync(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

/** Upsert KEY=value lines in .env, preserving unrelated lines and comments. */
function upsertEnvFile(entries) {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(entries));
  const nextLines = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && remaining.has(match[1])) {
      const value = remaining.get(match[1]);
      remaining.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === "")
    nextLines.pop();
  for (const [key, value] of remaining) nextLines.push(`${key}=${value}`);
  atomicWrite(ENV_PATH, `${nextLines.join("\n")}\n`);
  for (const [key, value] of Object.entries(entries)) {
    process.env[key] = value;
  }
}

// --- probe cache -------------------------------------------------------------

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
  for (const result of results) probeCache[result.family] = result;
  atomicWrite(PROBE_CACHE_PATH, `${JSON.stringify(probeCache, null, 2)}\n`);
}

// --- status assembly (server computes, client displays) ----------------------

function fieldSpecs(group) {
  const specs = [];
  const seen = new Set();
  const add = (names, tag) => {
    for (const name of names ?? []) {
      if (seen.has(name)) continue;
      seen.add(name);
      specs.push({ name, tag });
    }
  };
  add(group.requiredAll, "required");
  add(group.requiredAny, "any-of");
  add(group.optional, "optional");
  add(EXTRA_FIELDS_BY_GROUP[group.id], "probe");
  return specs;
}

function hasValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function familyState(fields, probes) {
  if (probes.some((probe) => probe.ok)) return "green";
  if (probes.length > 0) return "red";
  return fields.some((field) => field.present) ? "yellow" : "gray";
}

function buildStatusPayload() {
  loadDotenv();
  const families = CONNECTOR_GROUPS.map((group) => {
    const gs = groupStatus(group);
    const fields = fieldSpecs(group).map(({ name, tag }) => ({
      name,
      tag,
      secret: isSecretEnvName(name),
      present: hasValue(name),
      masked: hasValue(name) ? maskTail(process.env[name].trim()) : null,
    }));
    const probeFamilies = GROUP_PROBE_FAMILIES[group.id] ?? [];
    const probes = probeFamilies
      .map((family) => probeCache[family])
      .filter(Boolean);
    return {
      id: group.id,
      label: group.label,
      ready: gs.readyForOperatorRun,
      missingRequiredAll: gs.missingRequiredAll,
      missingRequiredAny: gs.missingRequiredAny,
      fields,
      probeFamilies,
      probes,
      state: familyState(fields, probes),
      oauth: OAUTH_GROUPS.has(group.id),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    envPath: ENV_PATH,
    probeCachePath: PROBE_CACHE_PATH,
    appLinks: {
      connectors: `${APP_BASE}/settings?section=connectors`,
      secrets: `${APP_BASE}/settings?section=secrets`,
      liveTest: `${APP_BASE}/lifeops-live-test`,
    },
    families,
  };
}

// --- HTTP plumbing ------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // error-policy:J3 request bodies are untrusted input; unparseable JSON is an explicit 400, never a defaulted object.
    throw new HttpError(400, "invalid JSON body");
  }
}

function handleEnvUpsert(body) {
  const { key, value } = body ?? {};
  if (typeof key !== "string" || !KNOWN_ENV_NAMES.has(key)) {
    throw new HttpError(
      400,
      `unknown env name${typeof key === "string" ? `: ${key}` : ""} — only connector credential names from CONNECTOR_GROUPS are writable`,
    );
  }
  if (typeof value !== "string")
    throw new HttpError(400, "value must be a string");
  if (value.length > MAX_VALUE_CHARS)
    throw new HttpError(400, `value exceeds ${MAX_VALUE_CHARS} chars`);
  if (/[\r\n]/.test(value))
    throw new HttpError(400, "value must not contain newlines");
  const trimmed = value.trim();
  const alsoWrote = WRITE_ALIASES[key] ?? [];
  const entries = { [key]: trimmed };
  for (const alias of alsoWrote) entries[alias] = trimmed;
  upsertEnvFile(entries);
  console.log(
    `[hitl-dashboard] env upsert ${key}${alsoWrote.length > 0 ? ` (+ ${alsoWrote.join(", ")})` : ""} = ${maskTail(trimmed) ?? "(cleared)"}`,
  );
  return { key, masked: maskTail(trimmed), alsoWrote };
}

function resolveProbeTargets(name) {
  if (PROBE_FAMILIES.includes(name)) return [name];
  const mapped = GROUP_PROBE_FAMILIES[name];
  if (mapped && mapped.length > 0) return mapped;
  throw new HttpError(
    400,
    `unknown probe family: ${name} (known: ${PROBE_FAMILIES.join(", ")}, finance)`,
  );
}

async function runProbes(families) {
  loadDotenv();
  const results = await probeAll(families);
  rememberProbes(results);
  for (const result of results) {
    console.log(
      `[hitl-dashboard] probe ${result.family}: ${result.ok ? "ok" : "FAIL"} — ${result.detail}`,
    );
  }
  return results;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
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
    sendJson(res, 200, handleEnvUpsert(await readJsonBody(req)));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/probe-all") {
    sendJson(res, 200, { results: await runProbes(PROBE_FAMILIES) });
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/probe/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/probe/".length));
    sendJson(res, 200, { results: await runProbes(resolveProbeTargets(name)) });
    return;
  }
  throw new HttpError(404, `no route: ${req.method} ${url.pathname}`);
}

// --- inline page ---------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LifeOps HITL Credentials (#11632)</title>
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
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; letter-spacing: 0.02em; }
  header .sub { color: var(--dim); font-size: 12px; }
  .spacer { flex: 1; }
  .links { display: flex; gap: 14px; font-size: 12px; }
  main { max-width: 1060px; margin: 0 auto; padding: 20px 22px 60px; display: grid; gap: 14px; }
  .family { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .family-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .dot.green { background: var(--green); } .dot.red { background: var(--red); }
  .dot.yellow { background: var(--yellow); } .dot.gray { background: var(--gray); }
  .family-head h2 { font-size: 14px; margin: 0; }
  .state-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; }
  .probe-detail { margin: 8px 0 2px; font-size: 12px; color: var(--dim); }
  .probe-detail .ok { color: var(--green); } .probe-detail .fail { color: var(--red); }
  .fields { margin-top: 10px; display: grid; gap: 6px; }
  .field { display: grid; grid-template-columns: minmax(220px, 1.2fr) 70px 84px minmax(180px, 1.6fr) auto; gap: 8px; align-items: center; }
  .field .name { font-family: var(--mono); font-size: 12px; word-break: break-all; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; text-align: center; }
  .tag.required { color: var(--accent); border-color: var(--accent); }
  .masked { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .masked.set { color: var(--text); }
  input[type="text"], input[type="password"] {
    width: 100%; background: #0c0c0f; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 8px; font-family: var(--mono); font-size: 12px;
    caret-color: var(--accent); accent-color: var(--accent);
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(255, 88, 0, 0.25); }
  button { border: 1px solid var(--border); border-radius: 6px; background: var(--panel-2); color: var(--text); padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: rgba(232, 230, 227, 0.12); }
  button:disabled { opacity: 0.5; cursor: wait; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #14100c; font-weight: 600; }
  button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .oauth-note { font-size: 12px; color: var(--dim); margin-top: 8px; }
  .toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 14px; font-size: 12px; max-width: 420px; display: none; }
  .toast.error { border-left-color: var(--red); }
  .meta { font-size: 11px; color: var(--dim); font-family: var(--mono); }
</style>
</head>
<body>
<header>
  <h1>LifeOps HITL credential intake</h1>
  <span class="sub">#11632 live-validation — values masked to last 4, saved to worktree .env</span>
  <span class="spacer"></span>
  <nav class="links" id="app-links"></nav>
  <button class="primary" id="probe-all">Probe all</button>
</header>
<main id="families"><p class="meta">loading…</p></main>
<div class="toast" id="toast"></div>
<script>
(function () {
  'use strict';
  var toastTimer = null;
  function toast(message, isError) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.className = isError ? 'toast error' : 'toast';
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 5000);
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
        return payload;
      });
    });
  }
  function stateLabel(state) {
    if (state === 'green') return 'probe ok';
    if (state === 'red') return 'probe failed';
    if (state === 'yellow') return 'present — unprobed';
    return 'missing';
  }
  function renderLinks(links) {
    var nav = document.getElementById('app-links');
    nav.textContent = '';
    var items = [
      ['Settings → Connectors', links.connectors],
      ['Settings → Secrets', links.secrets],
      ['Live-test view', links.liveTest],
    ];
    items.forEach(function (item) {
      var a = el('a', null, item[0]);
      a.href = item[1];
      a.target = '_blank';
      a.rel = 'noreferrer';
      nav.appendChild(a);
    });
  }
  function renderFamily(family, links) {
    var card = el('section', 'family');
    var head = el('div', 'family-head');
    head.appendChild(el('span', 'dot ' + family.state));
    head.appendChild(el('h2', null, family.label));
    head.appendChild(el('span', 'state-label', stateLabel(family.state)));
    var spacer = el('span', 'spacer');
    head.appendChild(spacer);
    if (family.probeFamilies.length > 0) {
      family.probeFamilies.forEach(function (probeName) {
        var button = el('button', null, 'Probe ' + probeName);
        button.addEventListener('click', function () {
          button.disabled = true;
          button.textContent = 'probing…';
          api('POST', '/api/probe/' + encodeURIComponent(probeName))
            .then(function (payload) {
              var result = payload.results[0];
              toast(result.family + ': ' + (result.ok ? 'ok — ' : 'FAILED — ') + result.detail, !result.ok);
              return refresh();
            })
            .catch(function (error) { toast(String(error.message || error), true); return refresh(); });
        });
        head.appendChild(button);
      });
    }
    card.appendChild(head);
    family.probes.forEach(function (probe) {
      var line = el('p', 'probe-detail');
      line.appendChild(el('span', probe.ok ? 'ok' : 'fail', probe.ok ? '● ok ' : '● failed '));
      line.appendChild(el('span', null, '[' + probe.family + '] ' + probe.detail + ' (' + probe.probedAt + ')'));
      card.appendChild(line);
    });
    if (family.oauth) {
      var note = el('p', 'oauth-note', 'OAuth family — paste bootstrap credentials here, then finish the real consent flow in the app: ');
      var a1 = el('a', null, 'Connectors'); a1.href = links.connectors; a1.target = '_blank'; a1.rel = 'noreferrer';
      var a2 = el('a', null, 'Secrets'); a2.href = links.secrets; a2.target = '_blank'; a2.rel = 'noreferrer';
      var a3 = el('a', null, 'Live-test'); a3.href = links.liveTest; a3.target = '_blank'; a3.rel = 'noreferrer';
      note.appendChild(a1); note.appendChild(document.createTextNode(' · '));
      note.appendChild(a2); note.appendChild(document.createTextNode(' · '));
      note.appendChild(a3);
      card.appendChild(note);
    }
    var fields = el('div', 'fields');
    family.fields.forEach(function (field) {
      var row = el('div', 'field');
      row.appendChild(el('span', 'name', field.name));
      row.appendChild(el('span', 'tag ' + field.tag, field.tag));
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
        save.disabled = true;
        api('POST', '/api/env', { key: field.name, value: input.value })
          .then(function (payload) {
            var extra = payload.alsoWrote.length > 0 ? ' (also wrote ' + payload.alsoWrote.join(', ') + ')' : '';
            toast('saved ' + payload.key + ' = ' + payload.masked + extra, false);
            return refresh();
          })
          .catch(function (error) { save.disabled = false; toast(String(error.message || error), true); });
      }
      save.addEventListener('click', submit);
      input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });
      row.appendChild(save);
      fields.appendChild(row);
    });
    card.appendChild(fields);
    return card;
  }
  function refresh() {
    return api('GET', '/api/status').then(function (status) {
      renderLinks(status.appLinks);
      var main = document.getElementById('families');
      main.textContent = '';
      status.families.forEach(function (family) {
        main.appendChild(renderFamily(family, status.appLinks));
      });
      var meta = el('p', 'meta', 'env: ' + status.envPath + ' · probes cached at ' + status.probeCachePath + ' · ' + status.generatedAt);
      main.appendChild(meta);
    });
  }
  document.getElementById('probe-all').addEventListener('click', function () {
    var button = document.getElementById('probe-all');
    button.disabled = true;
    button.textContent = 'probing all…';
    api('POST', '/api/probe-all')
      .then(function (payload) {
        var okCount = payload.results.filter(function (r) { return r.ok; }).length;
        toast('probe-all done: ' + okCount + '/' + payload.results.length + ' ok', false);
      })
      .catch(function (error) { toast(String(error.message || error), true); })
      .then(function () {
        button.disabled = false;
        button.textContent = 'Probe all';
        return refresh();
      });
  });
  refresh().catch(function (error) { toast(String(error.message || error), true); });
})();
</script>
</body>
</html>
`;

// --- boot -----------------------------------------------------------------------

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

if (import.meta.main) {
  loadDotenv();
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
  console.log(`[hitl-dashboard] listening on ${address}`);
  console.log(`[hitl-dashboard] env file: ${ENV_PATH}`);
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
