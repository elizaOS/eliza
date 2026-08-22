#!/usr/bin/env node

/**
 * Computes and verifies the exact-input evidence manifest for Develop Full.
 * Surface digests bind tracked bytes, transitive workspace dependencies,
 * dependent-surface digests, the reviewed graph, and the CI environment.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listWorkspaceDirs } from "./lib/workspaces.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEFAULT_GRAPH_PATH = ".github/develop-surface-graph.json";
const EVIDENCE_SCHEMA_VERSION = 1;
const EXPECTED_EVIDENCE_KEYS = [
  "conclusion",
  "createdAt",
  "environmentDigest",
  "evidenceDigest",
  "expiresAt",
  "graphDigest",
  "inputDigest",
  "schemaVersion",
  "sourceSha",
  "surface",
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function requireString(args, key) {
  if (typeof args[key] !== "string" || args[key].length === 0) {
    throw new Error(`--${key} is required`);
  }
  return args[key];
}

function git(repoRoot, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return result;
}

function globToRegExp(pattern) {
  if (pattern === "**") return /^[\s\S]*$/;
  const sentinel = "\0";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", sentinel)
    .replaceAll("*", "[^/]*")
    .replaceAll(sentinel, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

function matcher(patterns) {
  const expressions = patterns.map(globToRegExp);
  return (value) => expressions.some((expression) => expression.test(value));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

export function validateGraph(graph) {
  assertPlainObject(graph, "surface graph");
  if (graph.schemaVersion !== 1)
    throw new Error("unsupported graph schemaVersion");
  if (typeof graph.graphVersion !== "string" || !graph.graphVersion) {
    throw new Error("graphVersion must be a non-empty string");
  }
  if (
    !Number.isSafeInteger(graph.evidenceTtlHours) ||
    graph.evidenceTtlHours <= 0
  ) {
    throw new Error("evidenceTtlHours must be a positive safe integer");
  }
  assertPlainObject(graph.environment, "environment");
  if (!Array.isArray(graph.globalInputs) || graph.globalInputs.length === 0) {
    throw new Error("globalInputs must be non-empty");
  }
  if (!Array.isArray(graph.surfaces) || graph.surfaces.length === 0) {
    throw new Error("surface graph must contain at least one surface");
  }
  const ids = new Set();
  for (const surface of graph.surfaces) {
    assertPlainObject(surface, "surface");
    if (!/^[a-z][a-z0-9-]*$/.test(surface.id ?? "")) {
      throw new Error(`invalid surface id: ${surface.id}`);
    }
    if (ids.has(surface.id))
      throw new Error(`duplicate surface id: ${surface.id}`);
    ids.add(surface.id);
    if (typeof surface.workflow !== "string" || !surface.workflow) {
      throw new Error(`${surface.id}: workflow is required`);
    }
    for (const field of ["workspacePatterns", "inputs"]) {
      if (!Array.isArray(surface[field]))
        throw new Error(`${surface.id}: ${field} must be an array`);
    }
    if (surface.dependsOn !== undefined && !Array.isArray(surface.dependsOn)) {
      throw new Error(`${surface.id}: dependsOn must be an array`);
    }
  }
  for (const surface of graph.surfaces) {
    for (const dependency of surface.dependsOn ?? []) {
      if (!ids.has(dependency))
        throw new Error(`${surface.id}: unknown dependency ${dependency}`);
      if (dependency === surface.id)
        throw new Error(`${surface.id}: self dependency`);
    }
  }
  topologicalSurfaces(graph);
  return graph;
}

export function topologicalSurfaces(graph) {
  const byId = new Map(graph.surfaces.map((surface) => [surface.id, surface]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`surface dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id));
  }
  for (const id of [...byId.keys()].sort(compareText)) visit(id);
  return ordered;
}

function readGraph(repoRoot, graphPath = DEFAULT_GRAPH_PATH) {
  const graph = JSON.parse(
    readFileSync(path.join(repoRoot, graphPath), "utf8"),
  );
  return validateGraph(graph);
}

function trackedInventory(repoRoot) {
  const result = git(repoRoot, ["ls-files", "-s", "-z"]);
  const files = new Map();
  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const match = record.match(/^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
    if (!match) throw new Error(`malformed git ls-files record: ${record}`);
    const [, mode, objectId, stage, relativePath] = match;
    if (stage !== "0")
      throw new Error(`unmerged tracked path: ${relativePath}`);
    const absolutePath = path.join(repoRoot, relativePath);
    let contentDigest;
    if (mode === "160000") contentDigest = sha256(`gitlink:${objectId}`);
    else if (mode === "120000")
      contentDigest = sha256(readlinkSync(absolutePath));
    else {
      const stat = lstatSync(absolutePath);
      if (!stat.isFile())
        throw new Error(`tracked input is not a regular file: ${relativePath}`);
      contentDigest = sha256(readFileSync(absolutePath));
    }
    files.set(relativePath, { contentDigest, mode });
  }
  return files;
}

function workspaceInventory(repoRoot) {
  const byName = new Map();
  const byDirectory = new Map();
  for (const directory of listWorkspaceDirs({ repoRoot })) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, directory, "package.json"), "utf8"),
    );
    if (typeof manifest.name !== "string" || !manifest.name) {
      throw new Error(`${directory}/package.json has no workspace name`);
    }
    if (byName.has(manifest.name))
      throw new Error(`duplicate workspace name: ${manifest.name}`);
    const dependencies = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    );
    const entry = { dependencies, directory, name: manifest.name };
    byName.set(manifest.name, entry);
    byDirectory.set(directory, entry);
  }
  for (const entry of byName.values()) {
    entry.dependencies = new Set(
      [...entry.dependencies].filter((name) => byName.has(name)),
    );
  }
  return { byDirectory, byName };
}

function workspaceClosure(surface, workspaces) {
  const ownsWorkspace = matcher(surface.workspacePatterns);
  const pending = [...workspaces.byDirectory.values()]
    .filter((entry) => ownsWorkspace(entry.directory))
    .map((entry) => entry.name);
  const closure = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const dependency of workspaces.byName.get(name).dependencies)
      pending.push(dependency);
  }
  return [...closure].sort(compareText);
}

function workspaceForPath(relativePath, workspaces) {
  let match = null;
  for (const [directory, workspace] of workspaces.byDirectory) {
    if (
      relativePath === directory ||
      relativePath.startsWith(`${directory}/`)
    ) {
      if (!match || directory.length > match.directory.length)
        match = workspace;
    }
  }
  return match;
}

function changedFiles(repoRoot, base, head) {
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new Error(`head must be a full SHA: ${head}`);
  if (/^0{40}$/.test(base)) return [...trackedInventory(repoRoot).keys()];
  if (!/^[0-9a-f]{40}$/.test(base))
    throw new Error(`base must be a full SHA: ${base}`);
  const result = git(repoRoot, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    base,
    head,
  ]);
  const fields = result.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changed = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (/^[RC]\d{1,3}$/.test(status))
      changed.push(fields[index++], fields[index++]);
    else if (/^[ADMTUXB]$/.test(status)) changed.push(fields[index++]);
    else throw new Error(`unsupported git diff status: ${status}`);
  }
  if (changed.some((value) => typeof value !== "string" || !value)) {
    throw new Error("malformed changed-path inventory");
  }
  return [...new Set(changed)].sort(compareText);
}

function inputRows(paths, tracked) {
  return paths.map((relativePath) => {
    const entry = tracked.get(relativePath);
    if (!entry)
      throw new Error(`expected tracked input is absent: ${relativePath}`);
    return [relativePath, entry.mode, entry.contentDigest];
  });
}

export function computeExpectedManifest({
  baseSha,
  changedPaths,
  graph,
  headSha,
  tracked,
  workspaces,
}) {
  validateGraph(graph);
  if (tracked.size === 0) throw new Error("tracked input inventory is empty");
  const graphDigest = sha256(canonicalJson(graph));
  const environmentDigest = sha256(canonicalJson(graph.environment));
  const globalMatch = matcher(graph.globalInputs);
  const globalPaths = [...tracked.keys()].filter(globalMatch).sort(compareText);
  if (globalPaths.length === 0)
    throw new Error("globalInputs matched zero tracked files");
  const knownNonValidation = matcher(graph.knownNonValidationInputs ?? []);
  const ordered = topologicalSurfaces(graph);
  const surfaceState = new Map();

  for (const surface of ordered) {
    const closure = workspaceClosure(surface, workspaces);
    const closureDirectories = new Set(
      closure.map((name) => workspaces.byName.get(name).directory),
    );
    const directMatch = matcher([surface.workflow, ...surface.inputs]);
    const inputPaths = [...tracked.keys()]
      .filter((relativePath) => {
        if (globalMatch(relativePath) || directMatch(relativePath)) return true;
        const workspace = workspaceForPath(relativePath, workspaces);
        return workspace ? closureDirectories.has(workspace.directory) : false;
      })
      .sort(compareText);
    if (inputPaths.length === 0)
      throw new Error(`${surface.id}: input closure is empty`);
    const dependencyDigests = Object.fromEntries(
      (surface.dependsOn ?? [])
        .sort(compareText)
        .map((id) => [id, surfaceState.get(id).inputDigest]),
    );
    const inventory = inputRows(inputPaths, tracked);
    const inputInventoryDigest = sha256(canonicalJson(inventory));
    const inputDigest = sha256(
      canonicalJson({
        dependencyDigests,
        environmentDigest,
        graphDigest,
        inputInventoryDigest,
        surface: surface.id,
        workflow: surface.workflow,
        workspaceClosure: closure,
      }),
    );
    surfaceState.set(surface.id, {
      catchAll: surface.catchAll === true,
      dependencyDigests,
      id: surface.id,
      inputDigest,
      inputInventoryDigest,
      inputPaths,
      workspaceClosure: closure,
    });
  }

  const directlyTouched = new Set();
  const unknownPaths = [];
  for (const changedPath of changedPaths) {
    let owned = false;
    const changedWorkspace = workspaceForPath(changedPath, workspaces);
    if (globalMatch(changedPath)) {
      for (const surface of ordered) directlyTouched.add(surface.id);
      owned = true;
    }
    for (const surface of ordered) {
      const state = surfaceState.get(surface.id);
      const directMatch = matcher([surface.workflow, ...surface.inputs]);
      const workspaceMatch =
        changedWorkspace !== null &&
        state.workspaceClosure.includes(changedWorkspace.name);
      if (directMatch(changedPath) || workspaceMatch) {
        directlyTouched.add(surface.id);
        if (!state.catchAll) owned = true;
      }
    }
    if (!owned && !knownNonValidation(changedPath))
      unknownPaths.push(changedPath);
  }

  const invalidated = new Set(directlyTouched);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const surface of ordered) {
      if (invalidated.has(surface.id)) continue;
      if ((surface.dependsOn ?? []).some((id) => invalidated.has(id))) {
        invalidated.add(surface.id);
        expanded = true;
      }
    }
  }
  const forceAll = /^0{40}$/.test(baseSha) || unknownPaths.length > 0;
  if (forceAll) for (const surface of ordered) invalidated.add(surface.id);

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    baseSha,
    changedPaths,
    environment: graph.environment,
    environmentDigest,
    evidenceTtlHours: graph.evidenceTtlHours,
    graphDigest,
    graphVersion: graph.graphVersion,
    headSha,
    unknownPaths,
    surfaces: [...surfaceState.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map((surface) => ({
        dependencyDigests: surface.dependencyDigests,
        forceRun: forceAll,
        id: surface.id,
        inputDigest: surface.inputDigest,
        inputCount: surface.inputPaths.length,
        inputInventoryDigest: surface.inputInventoryDigest,
        invalidated: invalidated.has(surface.id),
        workspaceClosure: surface.workspaceClosure,
      })),
  };
}

function evidencePayload({
  createdAt,
  environmentDigest,
  expiresAt,
  graphDigest,
  inputDigest,
  sourceSha,
  surface,
}) {
  return {
    conclusion: "success",
    createdAt,
    environmentDigest,
    expiresAt,
    graphDigest,
    inputDigest,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    sourceSha,
    surface,
  };
}

export function createEvidence(expected, surfaceId, now, ttlHours) {
  const surface = expected.surfaces.find(
    (candidate) => candidate.id === surfaceId,
  );
  if (!surface) throw new Error(`unexpected evidence surface: ${surfaceId}`);
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(
    new Date(now).getTime() + ttlHours * 3_600_000,
  ).toISOString();
  const payload = evidencePayload({
    createdAt,
    environmentDigest: expected.environmentDigest,
    expiresAt,
    graphDigest: expected.graphDigest,
    inputDigest: surface.inputDigest,
    sourceSha: expected.headSha,
    surface: surfaceId,
  });
  return { ...payload, evidenceDigest: sha256(canonicalJson(payload)) };
}

export function verifyEvidence(expected, evidence, now = new Date()) {
  assertPlainObject(evidence, "evidence row");
  const keys = Object.keys(evidence).sort(compareText);
  if (canonicalJson(keys) !== canonicalJson(EXPECTED_EVIDENCE_KEYS)) {
    throw new Error(
      `${evidence.surface ?? "unknown"}: ambiguous evidence fields`,
    );
  }
  const surface = expected.surfaces.find(
    (candidate) => candidate.id === evidence.surface,
  );
  if (!surface)
    throw new Error(`unexpected evidence surface: ${evidence.surface}`);
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION)
    throw new Error(`${evidence.surface}: stale schema`);
  if (evidence.conclusion !== "success")
    throw new Error(`${evidence.surface}: evidence is not green`);
  if (!/^[0-9a-f]{40}$/.test(evidence.sourceSha))
    throw new Error(`${evidence.surface}: invalid source SHA`);
  if (evidence.inputDigest !== surface.inputDigest)
    throw new Error(`${evidence.surface}: input digest mismatch`);
  if (evidence.graphDigest !== expected.graphDigest)
    throw new Error(`${evidence.surface}: graph digest mismatch`);
  if (evidence.environmentDigest !== expected.environmentDigest)
    throw new Error(`${evidence.surface}: environment digest mismatch`);
  const createdAt = Date.parse(evidence.createdAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const nowMs = new Date(now).getTime();
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= createdAt
  ) {
    throw new Error(`${evidence.surface}: invalid evidence lifetime`);
  }
  if (expiresAt - createdAt > expected.evidenceTtlHours * 3_600_000) {
    throw new Error(`${evidence.surface}: evidence lifetime exceeds policy`);
  }
  if (expiresAt <= nowMs)
    throw new Error(`${evidence.surface}: evidence expired`);
  if (createdAt > nowMs + 300_000)
    throw new Error(`${evidence.surface}: evidence is from the future`);
  const { evidenceDigest, ...payload } = evidence;
  if (evidenceDigest !== sha256(canonicalJson(payload))) {
    throw new Error(`${evidence.surface}: evidence digest mismatch`);
  }
  return evidence;
}

export function verifyCompleteManifest(
  expected,
  evidenceRows,
  now = new Date(),
) {
  if (!Array.isArray(expected.surfaces) || expected.surfaces.length === 0) {
    throw new Error("expected manifest contains zero surfaces");
  }
  const expectedIds = new Set(expected.surfaces.map((surface) => surface.id));
  if (expectedIds.size !== expected.surfaces.length)
    throw new Error("duplicate expected surface");
  const observed = new Map();
  for (const row of evidenceRows) {
    verifyEvidence(expected, row, now);
    if (observed.has(row.surface))
      throw new Error(`duplicate observed surface: ${row.surface}`);
    observed.set(row.surface, row);
  }
  for (const id of expectedIds) {
    if (!observed.has(id)) throw new Error(`missing current evidence: ${id}`);
  }
  if (observed.size !== expectedIds.size)
    throw new Error("unexpected observed evidence");
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    environmentDigest: expected.environmentDigest,
    graphDigest: expected.graphDigest,
    headSha: expected.headSha,
    surfaces: [...observed.values()].sort((left, right) =>
      compareText(left.surface, right.surface),
    ),
  };
}

export function resolveEvidenceRuns(expected, evidenceRows, now = new Date()) {
  const bySurface = new Map();
  for (const row of evidenceRows) {
    if (bySurface.has(row.surface)) {
      throw new Error(`duplicate cached evidence: ${row.surface}`);
    }
    bySurface.set(row.surface, row);
  }
  return Object.fromEntries(
    expected.surfaces.map((surface) => {
      if (surface.forceRun) return [surface.id, true];
      const evidence = bySurface.get(surface.id);
      if (!evidence) return [surface.id, true];
      try {
        verifyEvidence(expected, evidence, now);
        return [surface.id, false];
      } catch {
        return [surface.id, true];
      }
    }),
  );
}

function readCachedRows(expected, root) {
  return expected.surfaces.flatMap((surface) => {
    const filePath = path.join(root, surface.id, "evidence.json");
    if (!existsSync(filePath)) return [];
    try {
      return [JSON.parse(readFileSync(filePath, "utf8"))];
    } catch {
      // error-policy:J3 a corrupt cache is an explicit miss, never reusable proof
      return [];
    }
  });
}

function appendOutput(outputPath, key, value) {
  if (outputPath) appendFileSync(outputPath, `${key}=${value}\n`);
}

function outputKey(prefix, surfaceId) {
  return `${prefix}_${surfaceId.replaceAll("-", "_")}`;
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadExpected(filePath) {
  const expected = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(expected.surfaces) || expected.surfaces.length === 0) {
    throw new Error("expected manifest contains zero surfaces");
  }
  return expected;
}

function planCommand(args) {
  const repoRoot = path.resolve(args.repo ?? DEFAULT_REPO_ROOT);
  const graph = readGraph(repoRoot, args.graph ?? DEFAULT_GRAPH_PATH);
  const baseSha = requireString(args, "base");
  const headSha = requireString(args, "head");
  const expectedPath = path.resolve(requireString(args, "expected"));
  const expected = computeExpectedManifest({
    baseSha,
    changedPaths: changedFiles(repoRoot, baseSha, headSha),
    graph,
    headSha,
    tracked: trackedInventory(repoRoot),
    workspaces: workspaceInventory(repoRoot),
  });
  writeJson(expectedPath, expected);
  for (const surface of expected.surfaces) {
    appendOutput(
      args["github-output"],
      outputKey("digest", surface.id),
      surface.inputDigest,
    );
  }
  console.log(
    `[develop-impact] planned ${expected.surfaces.length} surfaces; ${expected.unknownPaths.length} unknown path(s)`,
  );
}

function resolveCommand(args) {
  const expected = loadExpected(path.resolve(requireString(args, "expected")));
  const evidenceRoot = path.resolve(requireString(args, "evidence"));
  const rows = readCachedRows(expected, evidenceRoot);
  const runs = resolveEvidenceRuns(expected, rows);
  for (const surface of expected.surfaces) {
    appendOutput(
      args["github-output"],
      outputKey("run", surface.id),
      String(runs[surface.id]),
    );
  }
}

function recordCommand(args) {
  const expected = loadExpected(path.resolve(requireString(args, "expected")));
  const evidenceRoot = path.resolve(requireString(args, "evidence"));
  const results = JSON.parse(
    process.env[requireString(args, "results-env")] ?? "null",
  );
  assertPlainObject(results, "surface results");
  const graph = readGraph(
    path.resolve(args.repo ?? DEFAULT_REPO_ROOT),
    args.graph ?? DEFAULT_GRAPH_PATH,
  );
  const existing = new Map();
  for (const row of readCachedRows(expected, evidenceRoot)) {
    if (existing.has(row.surface))
      throw new Error(`duplicate cached evidence: ${row.surface}`);
    existing.set(row.surface, row);
  }
  const rows = [];
  for (const surface of expected.surfaces) {
    const result = results[surface.id];
    if (result === "success") {
      const row = createEvidence(
        expected,
        surface.id,
        new Date(),
        graph.evidenceTtlHours,
      );
      writeJson(path.join(evidenceRoot, surface.id, "evidence.json"), row);
      rows.push(row);
    } else if (result === "skipped") {
      if (surface.forceRun) {
        throw new Error(`${surface.id}: required execution was skipped`);
      }
      const row = existing.get(surface.id);
      if (!row)
        throw new Error(`${surface.id}: skipped without reusable evidence`);
      rows.push(verifyEvidence(expected, row));
    } else {
      throw new Error(
        `${surface.id}: validation result is ${result ?? "missing"}`,
      );
    }
  }
  const observed = verifyCompleteManifest(expected, rows);
  writeJson(path.resolve(requireString(args, "observed")), observed);
  console.log(
    `[develop-impact] verified ${rows.length} current evidence row(s)`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "plan") planCommand(args);
  else if (command === "resolve") resolveCommand(args);
  else if (command === "record") recordCommand(args);
  else
    throw new Error(
      "usage: develop-impact-evidence.mjs <plan|resolve|record> [options]",
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[develop-impact] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
