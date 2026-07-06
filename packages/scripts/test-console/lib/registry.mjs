/**
 * Test registry for the console: the discovered run-all-tests task plan,
 * joined with the guarded live-suite manifest and the connection catalog.
 *
 * Nothing here re-derives what committed sources of truth already know. The
 * task list is `run-all-tests.mjs --plan=json --all` verbatim; live gating is
 * `GUARDED_REAL_LIVE_SUITES` + `computeRealLiveAccounting` from
 * packages/scripts/lib/real-live-suites.mjs (the same accounting the
 * post-merge lane prints); connection ownership comes from connections.mjs.
 * The join key is the repo-relative directory: a guarded suite belongs to the
 * plan task whose `relativeDir` prefixes its path.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeRealLiveAccounting,
  GUARDED_REAL_LIVE_SUITES,
} from "../../lib/real-live-suites.mjs";
import {
  CONNECTIONS,
  connectionStatus,
  OPT_IN_GATES,
  varOwnership,
} from "./connections.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..", "..");

let cachedPlan = null;

/** Discover the full task plan (cached per process; ~1s cold). */
export function discoverPlan({ force = false } = {}) {
  if (cachedPlan && !force) return cachedPlan;
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "packages/scripts/run-all-tests.mjs"),
      "--plan=json",
      "--all",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `plan discovery failed (exit ${result.status}): ${result.stderr?.slice(0, 2000)}`,
    );
  }
  cachedPlan = JSON.parse(result.stdout);
  return cachedPlan;
}

/**
 * Effective env for gating decisions: ambient process env, overlaid with the
 * operator's saved credentials and opt-in toggles. Saved values win so the
 * console UI always reflects what a console-launched run would actually use.
 */
export function effectiveEnv(savedEnv, optInToggles = {}) {
  const env = { ...process.env, ...savedEnv };
  for (const [gate, on] of Object.entries(optInToggles)) {
    if (on) env[gate] = "1";
    else delete env[gate];
  }
  return env;
}

function suiteStatusIndex(env) {
  const accounting = computeRealLiveAccounting(env);
  const byFile = new Map();
  for (const s of accounting.armed)
    byFile.set(s.file, { state: "armed", notes: s.notes });
  for (const s of accounting.probed)
    byFile.set(s.file, { state: "probe", probe: s.probe });
  for (const s of accounting.optIn)
    byFile.set(s.file, { state: "opt-in", gate: s.gate });
  for (const s of accounting.missingCreds)
    byFile.set(s.file, { state: "missing-creds", missing: s.missing });
  for (const s of accounting.blocked)
    byFile.set(s.file, { state: "blocked", reason: s.reason });
  return byFile;
}

/** Which connections own each missing var (for "configure X to enable"). */
function missingToConnections(missing, owners) {
  const ids = new Set();
  for (const key of missing ?? []) {
    for (const id of owners.get(key) ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * Build the full console state: tasks annotated with their guarded live
 * suites, connection statuses, and the opt-in gate toggles.
 */
export function buildRegistry({
  savedCredentials = {},
  optInToggles = {},
  history = {},
}) {
  const plan = discoverPlan();
  const owners = varOwnership();

  const savedEnv = {};
  for (const values of Object.values(savedCredentials)) {
    Object.assign(savedEnv, values);
  }
  const env = effectiveEnv(savedEnv, optInToggles);
  const suiteIndex = suiteStatusIndex(env);

  // Attach each guarded suite to the deepest plan task dir that contains it.
  const tasksByDir = [...plan.tasks].sort(
    (a, b) => b.relativeDir.length - a.relativeDir.length,
  );
  const suitesByTaskLabel = new Map();
  const orphanSuites = [];
  for (const entry of GUARDED_REAL_LIVE_SUITES) {
    const status = suiteIndex.get(entry.file) ?? { state: "unknown" };
    const owner = tasksByDir.find((t) =>
      entry.file.startsWith(`${t.relativeDir}/`),
    );
    const annotated = {
      file: entry.file,
      ...status,
      requires: entry.requires ?? [],
      anyOf: entry.anyOf ?? [],
      optIn: entry.optIn,
      connections: missingToConnections(
        status.state === "missing-creds"
          ? status.missing
          : [...(entry.requires ?? []), ...(entry.anyOf ?? []).flat()],
        owners,
      ),
    };
    if (owner) {
      const list = suitesByTaskLabel.get(owner.label) ?? [];
      list.push(annotated);
      suitesByTaskLabel.set(owner.label, list);
    } else {
      orphanSuites.push(annotated);
    }
  }

  const tasks = plan.tasks.map((task) => ({
    ...task,
    liveSuites: suitesByTaskLabel.get(task.label) ?? [],
    last: history[task.label] ?? null,
  }));

  const connections = CONNECTIONS.map((connection) => {
    const saved = savedCredentials[connection.id] ?? {};
    const { configured, missing } = connectionStatus(connection, saved);
    // Count what this connection unlocks so the UI can rank setup impact.
    const unlocks = GUARDED_REAL_LIVE_SUITES.filter((entry) => {
      const needed = [...(entry.requires ?? []), ...(entry.anyOf ?? []).flat()];
      return needed.some((key) => connection.fields.some((f) => f.key === key));
    }).length;
    return {
      id: connection.id,
      label: connection.label,
      category: connection.category,
      kind: connection.kind,
      obtain: connection.obtain,
      oauth: connection.oauth ?? null,
      fields: connection.fields.map((f) => ({
        ...f,
        // Never ship raw secrets to the browser — presence + suffix only.
        set: Boolean((saved[f.key] ?? process.env[f.key] ?? "").trim()),
        hint: maskValue(saved[f.key] ?? process.env[f.key] ?? ""),
      })),
      configured,
      missing,
      unlocks,
    };
  });

  return {
    summary: plan.summary,
    tasks,
    orphanSuites,
    connections,
    optInGates: OPT_IN_GATES.map((gate) => ({
      ...gate,
      on:
        Boolean(optInToggles[gate.key]) ||
        (process.env[gate.key] ?? "") === "1",
    })),
    cloudStep: plan.cloudStep,
  };
}

function maskValue(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "•••";
  return `…${trimmed.slice(-4)}`;
}
