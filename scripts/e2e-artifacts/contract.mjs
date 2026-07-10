/**
 * Shared contract for per-test e2e artifact bundles (#15972): the one place
 * that defines where a run lives on disk, how a test's directory is named,
 * and what `manifest.json` / the run index look like. Producers (the
 * packages/app Playwright reporter, the ui-runner/scenario sweeper, the
 * PostHog sink) write through these helpers; consumers (the e2e viewer, the
 * AI review orchestrator, evidence-bundle ingest) read the same shapes.
 *
 * Concurrency model: producers only ever write inside their own test
 * directory — the run-level `index.json` is DERIVED by scanning every
 * `tests/<dir>/manifest.json` (`buildRunIndex`), so parallel workers never
 * contend on a shared file.
 *
 * Everything under the run root is generated output and must stay gitignored
 * (the root `.gitignore` covers the `e2e` directory).
 */

import fs from "node:fs";
import path from "node:path";

export const TEST_MANIFEST_SCHEMA = "elizaos.e2e.test/1";
export const RUN_INDEX_SCHEMA = "elizaos.e2e.run/1";

/** Artifact kinds the viewer + AI reviewer understand. */
export const ARTIFACT_KINDS = [
  "video",
  "trace",
  "screenshot",
  "state-screenshot",
  "console-log",
  "network-log",
  "server-log",
  "trajectory",
  "posthog-events",
  "posthog-snapshots",
  "ocr",
  "report",
  "junit",
  "ai-review",
  "other",
];

/**
 * Run root: `<repo>/e2e` unless `ELIZA_E2E_ARTIFACTS_DIR` overrides it (CI
 * runners point it at a mounted volume).
 */
export function resolveArtifactsRoot(repoRoot) {
  const override = process.env.ELIZA_E2E_ARTIFACTS_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(repoRoot, "e2e");
}

/**
 * One run = one invocation of a lane (or of the whole matrix). Reused across
 * producers within the invocation via `ELIZA_E2E_RUN_ID` so every lane's
 * tests land in the same run.
 */
export function resolveRunId() {
  const fromEnv = process.env.ELIZA_E2E_RUN_ID;
  if (fromEnv && /^[a-zA-Z0-9._-]+$/.test(fromEnv)) return fromEnv;
  const now = new Date();
  const stamp = now.toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
  return `run-${stamp}`;
}

export function runDir(repoRoot, runId = resolveRunId()) {
  return path.join(resolveArtifactsRoot(repoRoot), runId);
}

/** The test's directory under the run — the only place a producer writes. */
export function testDir(repoRoot, runId, testId) {
  return path.join(runDir(repoRoot, runId), "tests", sanitizeTestId(testId));
}

/**
 * A test id is `<lane>:<file>:<title path>`; sanitized to a filesystem-safe
 * slug that stays readable and unique enough (a short hash guards against
 * collisions after truncation).
 */
export function sanitizeTestId(raw) {
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  let hash = 0;
  for (const ch of String(raw)) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return `${slug || "test"}-${hash.toString(36)}`;
}

/**
 * Write (or overwrite) a test manifest. `artifacts[].path` entries are
 * RELATIVE to the test dir; kinds outside ARTIFACT_KINDS are coerced to
 * "other" so a stale producer can never break consumers.
 */
export function writeTestManifest(dir, manifest) {
  const normalized = {
    schema: TEST_MANIFEST_SCHEMA,
    ...manifest,
    artifacts: (manifest.artifacts ?? []).map((artifact) => ({
      ...artifact,
      kind: ARTIFACT_KINDS.includes(artifact.kind) ? artifact.kind : "other",
    })),
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  return normalized;
}

export function readTestManifest(dir) {
  const file = path.join(dir, "manifest.json");
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.schema !== TEST_MANIFEST_SCHEMA) return null;
  return parsed;
}

/**
 * Derive the run index by scanning per-test manifests. Called by the viewer
 * and the AI reviewer at read time (and by lanes that want to persist it via
 * `writeRunIndex`); never incrementally mutated.
 */
export function buildRunIndex(repoRoot, runId) {
  const root = runDir(repoRoot, runId);
  const testsRoot = path.join(root, "tests");
  const tests = [];
  if (fs.existsSync(testsRoot)) {
    for (const entry of fs.readdirSync(testsRoot).sort()) {
      const dir = path.join(testsRoot, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      const manifest = readTestManifest(dir);
      if (!manifest) continue;
      tests.push({
        id: manifest.id,
        dir: `tests/${entry}`,
        title: manifest.title,
        lane: manifest.lane,
        project: manifest.project ?? null,
        file: manifest.file ?? null,
        status: manifest.status,
        durationMs: manifest.durationMs ?? null,
        startedAt: manifest.startedAt ?? null,
        artifactCounts: countByKind(manifest.artifacts ?? []),
      });
    }
  }
  return {
    schema: RUN_INDEX_SCHEMA,
    runId,
    generatedAt: new Date().toISOString(),
    testCount: tests.length,
    statusCounts: countBy(tests, (t) => t.status),
    laneCounts: countBy(tests, (t) => t.lane),
    tests,
  };
}

export function writeRunIndex(repoRoot, runId) {
  const index = buildRunIndex(repoRoot, runId);
  fs.writeFileSync(
    path.join(runDir(repoRoot, runId), "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

/** Latest run id under the artifacts root (by directory name sort). */
export function latestRunId(repoRoot) {
  const root = resolveArtifactsRoot(repoRoot);
  if (!fs.existsSync(root)) return null;
  const runs = fs
    .readdirSync(root)
    .filter((name) => {
      const dir = path.join(root, name);
      return (
        fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "tests"))
      );
    })
    .sort();
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

function countByKind(artifacts) {
  return countBy(artifacts, (artifact) => artifact.kind);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
