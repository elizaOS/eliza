/**
 * Persistent state for the local test console under `~/.eliza/test-console/`.
 *
 * Owns three things: the operator's saved credentials (`credentials.json`,
 * written 0600 because it holds raw API keys and OAuth tokens), the per-run
 * archives (`runs/<runId>/run.json` + one log file per task), and the rolling
 * last-status map (`history.json`) that survives server restarts so "re-run
 * failed" works across sessions. Everything is plain JSON on disk — the
 * console is a single-operator dev tool, so file locking is out of scope.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Dir precedence mirrors the repo's two state-dir conventions: an explicit
// override wins, then the core ELIZA_STATE_DIR root, then the `~/.eliza`
// home used by the CLI auth flows (register.auth.ts) — the human-facing
// default the console advertises. Resolved lazily so tests can point the
// store at a temp dir after import.
export function consoleDir() {
  return (
    process.env.ELIZA_TEST_CONSOLE_DIR ||
    (process.env.ELIZA_STATE_DIR
      ? path.join(process.env.ELIZA_STATE_DIR, "test-console")
      : path.join(os.homedir(), ".eliza", "test-console"))
  );
}

const CREDENTIALS_FILE = () => path.join(consoleDir(), "credentials.json");
const HISTORY_FILE = () => path.join(consoleDir(), "history.json");
const RUNS_DIR = () => path.join(consoleDir(), "runs");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Atomic-ish write: rename over the target so a crash mid-write never leaves
// truncated JSON behind (the console re-reads these files on every boot).
function writeJson(file, value, { mode } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

/** Credentials: `{ [connectionId]: { [ENV_VAR]: value } }`. */
export function loadCredentials() {
  return readJson(CREDENTIALS_FILE(), {});
}

export function saveCredentials(credentials) {
  writeJson(CREDENTIALS_FILE(), credentials, { mode: 0o600 });
}

export function setConnection(connectionId, values) {
  const all = loadCredentials();
  all[connectionId] = values;
  saveCredentials(all);
  return all;
}

export function removeConnection(connectionId) {
  const all = loadCredentials();
  delete all[connectionId];
  saveCredentials(all);
  return all;
}

/** Flatten every saved connection's vars into one env object for test runs. */
export function credentialsToEnv(credentials = loadCredentials()) {
  const env = {};
  for (const values of Object.values(credentials)) {
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
  }
  return env;
}

/** Console settings: opt-in gate toggles, cloud base URL, UI prefs. */
export function loadSettings() {
  return readJson(path.join(consoleDir(), "settings.json"), {
    optInToggles: {},
  });
}

export function saveSettings(settings) {
  writeJson(path.join(consoleDir(), "settings.json"), settings);
}

/** Last-known task status by label: `{ [label]: { status, runId, at } }`. */
export function loadHistory() {
  return readJson(HISTORY_FILE(), {});
}

export function recordTaskStatus(label, entry) {
  const history = loadHistory();
  history[label] = entry;
  writeJson(HISTORY_FILE(), history);
}

export function newRunDir(runId) {
  const dir = path.join(RUNS_DIR(), runId);
  ensureDir(path.join(dir, "logs"));
  return dir;
}

export function saveRunManifest(runId, manifest) {
  writeJson(path.join(RUNS_DIR(), runId, "run.json"), manifest);
}

export function listRuns() {
  if (!fs.existsSync(RUNS_DIR())) return [];
  return fs
    .readdirSync(RUNS_DIR())
    .filter((name) => fs.existsSync(path.join(RUNS_DIR(), name, "run.json")))
    .sort()
    .reverse()
    .map((name) => readJson(path.join(RUNS_DIR(), name, "run.json"), null))
    .filter(Boolean);
}

export function loadRun(runId) {
  return readJson(path.join(RUNS_DIR(), runId, "run.json"), null);
}

export function runLogPath(runId, taskSlug) {
  return path.join(RUNS_DIR(), runId, "logs", `${taskSlug}.log`);
}
