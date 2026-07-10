/**
 * Folds non-Playwright lane outputs into a per-test e2e artifact run
 * (#15972): the 33 bespoke packages/ui `__e2e__` runner output dirs, the
 * scenario-runner report bundles (with their LLM trajectories), and the
 * packages/app aesthetic-audit output each become test entries under
 * `e2e/<run>/tests/` alongside the Playwright reporter's entries, so the
 * viewer and the AI reviewer see ONE corpus. Artifacts are copied (not
 * symlinked) so a run directory is self-contained and survives `bun clean`.
 *
 * Statuses are honest: scenario entries carry the report's pass/fail; audit
 * entries derive from ocr-triage (`broken`); ui runner dirs have no recorded
 * exit code on disk, so they sweep as `captured` unless a lane log written
 * by run.mjs says otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRunId,
  testDir,
  writeRunIndex,
  writeTestManifest,
} from "./contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO_RE = /\.(webm|mp4|mov)$/i;
const LOG_RE = /\.(log|txt|out|err)$/i;
const REPORT_RE = /\.(json|jsonl|xml|junit)$/i;

function copyArtifact(sourceFile, destDir, relName) {
  const dest = path.join(destDir, relName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(sourceFile, dest);
  return relName;
}

function classifyKind(name) {
  if (IMAGE_RE.test(name)) return "screenshot";
  if (VIDEO_RE.test(name)) return "video";
  if (LOG_RE.test(name)) return "server-log";
  if (/trajector/i.test(name)) return "trajectory";
  if (REPORT_RE.test(name)) return "report";
  return "other";
}

/** Sweep every packages/ui `__e2e__/output*` dir into one test entry each. */
function sweepUiRunnerOutputs(runId, laneStatuses) {
  const uiSrc = path.join(REPO_ROOT, "packages", "ui", "src");
  const outputs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (dir.endsWith("__e2e__") && entry.name.startsWith("output")) {
        outputs.push(full);
      } else if (entry.name !== "node_modules") {
        walk(full);
      }
    }
  };
  if (fs.existsSync(uiSrc)) walk(uiSrc);

  let swept = 0;
  for (const outputDir of outputs) {
    const rel = path.relative(uiSrc, outputDir);
    // src/components/shell/__e2e__/output-webkit → ui-e2e:components/shell#webkit
    const laneName = rel
      .replace(/\/__e2e__\/output/, "#")
      .replace(/#$/, "#default")
      .replace(/^#/, "root#");
    const id = `ui-e2e:${laneName}`;
    const dir = testDir(REPO_ROOT, runId, id);
    const artifacts = [];
    const files = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => f.name)
      .sort();
    if (files.length === 0) continue;
    for (const name of files) {
      const kind = classifyKind(name);
      const relName = copyArtifact(path.join(outputDir, name), dir, name);
      artifacts.push({ kind, path: relName, label: name });
    }
    writeTestManifest(dir, {
      id,
      runId,
      lane: "ui-e2e",
      project: laneName,
      file: path.relative(REPO_ROOT, outputDir),
      title: `ui __e2e__ ${laneName}`,
      status: laneStatuses.get(id) ?? "captured",
      artifacts,
    });
    swept += 1;
  }
  return swept;
}

/** Sweep scenario-runner report bundles: one test per scenario result. */
function sweepScenarioReports(runId) {
  const reportsRoot = path.join(
    REPO_ROOT,
    "packages",
    "scenario-runner",
    "reports",
    "scenarios",
  );
  if (!fs.existsSync(reportsRoot)) return 0;
  let swept = 0;
  for (const lane of fs.readdirSync(reportsRoot)) {
    const laneDir = path.join(reportsRoot, lane);
    if (!fs.statSync(laneDir).isDirectory()) continue;
    const matrixFile = path.join(laneDir, "matrix.json");
    if (!fs.existsSync(matrixFile)) continue;
    let matrix;
    try {
      matrix = JSON.parse(fs.readFileSync(matrixFile, "utf8"));
    } catch {
      // error-policy:J3 unreadable report is an explicit skip, not a crash —
      // the lane's own run already reported its failure.
      continue;
    }
    const entries = Array.isArray(matrix)
      ? matrix
      : (matrix.results ?? matrix.scenarios ?? []);
    for (const entry of entries) {
      const scenarioId =
        entry.scenarioId ?? entry.id ?? entry.scenario ?? "unknown";
      const id = `scenario:${lane}:${scenarioId}`;
      const dir = testDir(REPO_ROOT, runId, id);
      const artifacts = [];
      // The per-scenario report file (NNN-<id>.json) plus any trajectories.
      for (const name of fs.readdirSync(laneDir)) {
        if (name.includes(String(scenarioId)) && REPORT_RE.test(name)) {
          artifacts.push({
            kind: "report",
            path: copyArtifact(path.join(laneDir, name), dir, name),
            label: name,
          });
        }
      }
      const trajRoot = path.join(laneDir, "trajectories");
      if (fs.existsSync(trajRoot)) {
        for (const agentDir of fs.readdirSync(trajRoot)) {
          const agentPath = path.join(trajRoot, agentDir);
          if (!fs.statSync(agentPath).isDirectory()) continue;
          for (const file of fs.readdirSync(agentPath)) {
            artifacts.push({
              kind: "trajectory",
              path: copyArtifact(
                path.join(agentPath, file),
                dir,
                path.join("trajectories", agentDir, file),
              ),
              label: `${agentDir}/${file}`,
            });
          }
        }
      }
      const passed =
        entry.passed === true ||
        entry.status === "passed" ||
        entry.verdict === "pass";
      writeTestManifest(dir, {
        id,
        runId,
        lane: `scenario:${lane}`,
        project: lane,
        file: path.relative(REPO_ROOT, matrixFile),
        title: `scenario ${scenarioId}`,
        status: passed ? "passed" : "failed",
        durationMs: entry.durationMs ?? null,
        summary: entry.failure ?? entry.error ?? null,
        artifacts,
      });
      swept += 1;
    }
  }
  return swept;
}

/** Sweep the aesthetic-audit output as one entry (per-view artifacts). */
function sweepAppAudit(runId) {
  const auditDir = path.join(
    REPO_ROOT,
    "packages",
    "app",
    "aesthetic-audit-output",
  );
  if (!fs.existsSync(auditDir)) return 0;
  const id = "audit:app";
  const dir = testDir(REPO_ROOT, runId, id);
  const artifacts = [];
  let broken = null;
  const ocrFile = path.join(auditDir, "ocr-triage.json");
  if (fs.existsSync(ocrFile)) {
    try {
      broken = JSON.parse(fs.readFileSync(ocrFile, "utf8")).summary?.broken;
    } catch {
      // error-policy:J3 malformed triage — status stays "captured" below.
    }
    artifacts.push({
      kind: "ocr",
      path: copyArtifact(ocrFile, dir, "ocr-triage.json"),
      label: "ocr-triage.json",
    });
  }
  const reportFile = path.join(auditDir, "report.json");
  if (fs.existsSync(reportFile)) {
    artifacts.push({
      kind: "report",
      path: copyArtifact(reportFile, dir, "report.json"),
      label: "report.json",
    });
  }
  for (const viewport of [
    "desktop-landscape",
    "mobile-portrait",
    "mobile-landscape",
    "ipad-portrait",
  ]) {
    const vpDir = path.join(auditDir, viewport);
    if (!fs.existsSync(vpDir)) continue;
    for (const name of fs.readdirSync(vpDir)) {
      if (!IMAGE_RE.test(name)) continue;
      artifacts.push({
        kind: "screenshot",
        path: copyArtifact(
          path.join(vpDir, name),
          dir,
          path.join(viewport, name),
        ),
        label: `${viewport}/${name}`,
      });
    }
  }
  if (artifacts.length === 0) return 0;
  writeTestManifest(dir, {
    id,
    runId,
    lane: "audit:app",
    title: "app aesthetic audit (all views)",
    file: "packages/app/aesthetic-audit-output",
    status: broken === 0 ? "passed" : broken == null ? "captured" : "failed",
    summary: broken == null ? null : `ocr-triage broken=${broken}`,
    artifacts,
  });
  return 1;
}

function parseArgs(argv) {
  const args = { runId: null, lanes: ["ui", "scenarios", "audit"] };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--run") args.runId = argv[++i];
    else if (argv[i] === "--lanes") args.lanes = argv[++i].split(",");
  }
  return args;
}

const args = parseArgs(process.argv);
const runId = args.runId ?? resolveRunId();
// Lane statuses recorded by run.mjs (when this sweep runs standalone the map
// is empty and ui entries stay "captured").
const laneStatuses = new Map();
const laneStatusFile = path.join(REPO_ROOT, "e2e", runId, "lane-status.json");
if (fs.existsSync(laneStatusFile)) {
  const parsed = JSON.parse(fs.readFileSync(laneStatusFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    laneStatuses.set(key, value);
  }
}

let total = 0;
if (args.lanes.includes("ui")) {
  total += sweepUiRunnerOutputs(runId, laneStatuses);
}
if (args.lanes.includes("scenarios")) total += sweepScenarioReports(runId);
if (args.lanes.includes("audit")) total += sweepAppAudit(runId);
const index = writeRunIndex(REPO_ROOT, runId);
console.log(
  `[e2e-sweep] run=${runId} swept=${total} totalTests=${index.testCount}`,
);
