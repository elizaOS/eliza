#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INDEX_DIR = path.join(REPO_ROOT, "reports", "benchmarks", "code-agent-run-index");
const INDEX_DATA_PATH = path.join(INDEX_DIR, "index-data.js");
const MIRROR_ROOT = path.join(REPO_ROOT, "reports", "benchmarks", "code-agent-runs");

function parseIndexData(indexDataPath) {
  return JSON.parse(
    readFileSync(indexDataPath, "utf8")
      .replace(/^window\.BENCHMARK_RUN_INDEX = /, "")
      .replace(/;\n?$/, ""),
  );
}

function candidateIndexDirs() {
  return [
    INDEX_DIR,
    "/tmp/eliza-code-agent-run-index",
    "/private/tmp/eliza-code-agent-run-index",
  ].filter((dir, index, values) => values.indexOf(dir) === index);
}

function selectIndexSource() {
  const candidates = [];
  for (const dir of candidateIndexDirs()) {
    const indexDataPath = path.join(dir, "index-data.js");
    if (!existsSync(indexDataPath)) continue;
    try {
      const data = parseIndexData(indexDataPath);
      candidates.push({
        dir,
        indexDataPath,
        data,
        rowCount: (data.benchmark_rows || []).length,
        mtimeMs: statSync(indexDataPath).mtimeMs,
      });
    } catch {
      // Ignore stale or partially written index files.
    }
  }
  if (!candidates.length) {
    throw new Error(`No benchmark run index found at ${INDEX_DATA_PATH}`);
  }
  candidates.sort((left, right) => {
    if (right.rowCount !== left.rowCount) return right.rowCount - left.rowCount;
    return right.mtimeMs - left.mtimeMs;
  });
  return candidates[0];
}

function readIndexData() {
  const source = selectIndexSource();
  mkdirSync(INDEX_DIR, { recursive: true });
  for (const file of ["index.html", "analysis.md"]) {
    const sourcePath = path.join(source.dir, file);
    const targetPath = path.join(INDEX_DIR, file);
    if (existsSync(sourcePath) && path.resolve(sourcePath) !== path.resolve(targetPath)) {
      cpSync(sourcePath, targetPath);
    }
  }
  return source.data;
}

function writeIndexData(data) {
  writeFileSync(
    INDEX_DATA_PATH,
    `window.BENCHMARK_RUN_INDEX = ${JSON.stringify(data)};\n`,
    "utf8",
  );
}

function runRootFromViewerHref(viewerHref) {
  if (!viewerHref) return "";
  if (String(viewerHref).startsWith("file://")) {
    const pathname = new URL(viewerHref).pathname;
    return path.dirname(path.dirname(pathname));
  }
  return "";
}

function safeName(value) {
  return String(value || "run")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180) || "run";
}

function pathWithinRunRoot(value, sourceRoot, mirrorRoot) {
  if (!value || !sourceRoot) return value;
  const text = String(value);
  if (!path.isAbsolute(text)) return value;
  const relative = path.relative(sourceRoot, text);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return path.join(mirrorRoot, relative);
}

function addCellProvenance(row, mirrorRoot) {
  for (const prefix of ["target", "baseline"]) {
    const adapter = row[`${prefix}_adapter`];
    if (!row.benchmark || !adapter) continue;
    const cellRoot = path.join(mirrorRoot, String(row.benchmark), String(adapter));
    const commandPath = path.join(cellRoot, "command.json");
    const trajectoryDir = path.join(cellRoot, "trajectories");
    if (existsSync(commandPath)) row[`${prefix}_command_path`] = commandPath;
    if (existsSync(trajectoryDir)) row[`${prefix}_trajectory_dir`] = trajectoryDir;
  }
}

function mirrorExternalCellArtifacts(row, prefix, mirrorRoot) {
  const adapter = row[`${prefix}_adapter`];
  const resultPath = row[`${prefix}_result_path`];
  if (!row.benchmark || !adapter || !resultPath || !path.isAbsolute(String(resultPath))) {
    return;
  }
  let currentResultPath = String(resultPath);
  if (currentResultPath.startsWith(mirrorRoot) && existsSync(currentResultPath)) return;
  if (row[`original_${prefix}_result_path`]) {
    currentResultPath = String(row[`original_${prefix}_result_path`]);
  }
  if (!existsSync(currentResultPath)) {
    const resultName = path.basename(String(resultPath));
    const runBase = String(row.run_id || "").replace(/-matrix$/, "");
    for (const root of ["/tmp", "/private/tmp"]) {
      const candidate = path.join(root, runBase, String(adapter), resultName);
      if (existsSync(candidate)) {
        currentResultPath = candidate;
        break;
      }
    }
  }
  if (!existsSync(currentResultPath)) return;
  row[`original_${prefix}_result_path`] = currentResultPath;
  const sourceCellRoot = path.dirname(currentResultPath);
  const mirrorCellRoot = path.join(mirrorRoot, String(row.benchmark), String(adapter));
  rmSync(mirrorCellRoot, { recursive: true, force: true });
  cpSync(sourceCellRoot, mirrorCellRoot, { recursive: true, dereference: false });
  row[`${prefix}_result_path`] = path.join(mirrorCellRoot, path.basename(currentResultPath));
}

function mirrorRuns(data) {
  mkdirSync(MIRROR_ROOT, { recursive: true });
  const bySource = new Map();
  for (const row of data.benchmark_rows || []) {
    const sourceRoot = row.original_run_root || row.run_root || runRootFromViewerHref(row.viewer_href);
    if (!sourceRoot || !existsSync(sourceRoot)) continue;
    const runId = safeName(row.run_id || path.basename(sourceRoot));
    bySource.set(sourceRoot, path.join(MIRROR_ROOT, runId));
  }
  for (const [sourceRoot, mirrorRoot] of bySource) {
    rmSync(mirrorRoot, { recursive: true, force: true });
    cpSync(sourceRoot, mirrorRoot, {
      recursive: true,
      dereference: false,
      filter: (source) => !source.includes(`${path.sep}.git${path.sep}`),
    });
  }
  return bySource;
}

function rewriteRows(rows, bySource) {
  for (const row of rows || []) {
    const sourceRoot = row.original_run_root || row.run_root || runRootFromViewerHref(row.viewer_href);
    const mirrorRoot = bySource.get(sourceRoot);
    if (!mirrorRoot) continue;
    row.original_run_root = sourceRoot;
    row.run_root = mirrorRoot;
    row.viewer_href = path.relative(INDEX_DIR, path.join(mirrorRoot, "viewer", "index.html")).replaceAll(path.sep, "/");
    row.target_result_path = pathWithinRunRoot(row.target_result_path, sourceRoot, mirrorRoot);
    row.baseline_result_path = pathWithinRunRoot(row.baseline_result_path, sourceRoot, mirrorRoot);
    mirrorExternalCellArtifacts(row, "target", mirrorRoot);
    mirrorExternalCellArtifacts(row, "baseline", mirrorRoot);
    addCellProvenance(row, mirrorRoot);
  }
}

function rewriteRuns(runs, bySource) {
  for (const run of runs || []) {
    const sourceRoot = run.artifact_paths?.run_root;
    const mirrorRoot = bySource.get(sourceRoot);
    if (!mirrorRoot) continue;
    run.original_artifact_paths = run.artifact_paths;
    run.artifact_paths = {
      ...run.artifact_paths,
      run_root: mirrorRoot,
      report_rows_csv: pathWithinRunRoot(run.artifact_paths?.report_rows_csv, sourceRoot, mirrorRoot),
      report_rows_jsonl: pathWithinRunRoot(run.artifact_paths?.report_rows_jsonl, sourceRoot, mirrorRoot),
      summary_json: pathWithinRunRoot(run.artifact_paths?.summary_json, sourceRoot, mirrorRoot),
      summary_md: pathWithinRunRoot(run.artifact_paths?.summary_md, sourceRoot, mirrorRoot),
      viewer_data: pathWithinRunRoot(run.artifact_paths?.viewer_data, sourceRoot, mirrorRoot),
      viewer_index: pathWithinRunRoot(run.artifact_paths?.viewer_index, sourceRoot, mirrorRoot),
    };
  }
}

function main() {
  const data = readIndexData();
  const bySource = mirrorRuns(data);
  rewriteRows(data.benchmark_rows, bySource);
  rewriteRows(Object.values(data.latest_by_benchmark || {}), bySource);
  rewriteRuns(data.runs, bySource);
  data.mirrored_run_artifacts = {
    generated_at: new Date().toISOString(),
    mirror_root: MIRROR_ROOT,
    mirrored_run_count: bySource.size,
    runs: [...bySource.entries()].map(([sourceRoot, mirrorRoot]) => ({
      sourceRoot,
      mirrorRoot,
      viewerHref: path.relative(INDEX_DIR, path.join(mirrorRoot, "viewer", "index.html")).replaceAll(path.sep, "/"),
      fileUrl: pathToFileURL(path.join(mirrorRoot, "viewer", "index.html")).href,
    })),
  };
  writeIndexData(data);
  writeFileSync(
    path.join(MIRROR_ROOT, "manifest.json"),
    JSON.stringify(data.mirrored_run_artifacts, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`mirrored ${bySource.size} benchmark run folders to ${MIRROR_ROOT}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
