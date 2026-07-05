/**
 * Device-e2e bundle assembly for the mobile runners.
 *
 * The runners exercise real devices and fail at many layers: build, install,
 * device boot, local agent startup, WebView driving, and cloud provisioning.
 * This module keeps those phases visible in one run directory even when the
 * process exits non-zero, and prepares inline-friendly evidence files for PR
 * comments without sending new output to the retired issue-evidence tree.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const INLINE_EXTENSIONS = new Set([".jpg", ".jpeg", ".mp4"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);
const LOG_EXTENSIONS = new Set([".log", ".txt", ".json", ".jsonl"]);

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    // error-policy:J3 Artifact paths can disappear while a failing runner unwinds.
    return false;
  }
}

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    // error-policy:J3 Missing conversion output is an invalid artifact signal.
    return false;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function uniquePath(dir, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function slugifyStepName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // error-policy:J3 Unreadable artifact roots are skipped, not reported as collected.
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function shellAvailable(cmd) {
  return spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
}

function convertPngToJpg(src, dest) {
  if (process.platform === "darwin") {
    const sips = spawnSync(
      "sips",
      ["-s", "format", "jpeg", src, "--out", dest],
      { stdio: "ignore" },
    );
    if (sips.status === 0 && isNonEmptyFile(dest)) return true;
  }
  if (shellAvailable("ffmpeg")) {
    const ffmpeg = spawnSync(
      "ffmpeg",
      ["-y", "-i", src, "-frames:v", "1", "-q:v", "2", dest],
      { stdio: "ignore" },
    );
    if (ffmpeg.status === 0 && isNonEmptyFile(dest)) return true;
  }
  return false;
}

function remuxMovToMp4(src, dest) {
  if (!shellAvailable("ffmpeg")) return false;
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", src, "-c", "copy", "-movflags", "+faststart", dest],
    { stdio: "ignore" },
  );
  return result.status === 0 && isNonEmptyFile(dest);
}

export function parseOutputDirArg(argv) {
  const index = argv.indexOf("--output");
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

export function defaultDeviceE2eOutputDir({ appDir, lane, date = new Date() }) {
  return path.join(appDir, "device-e2e-output", `${lane}-${timestampId(date)}`);
}

export function createDeviceE2eBundle({
  appDir,
  lane,
  outputDir,
  startedAt = new Date(),
  device = {},
  build = {},
}) {
  const root = path.resolve(
    outputDir ?? defaultDeviceE2eOutputDir({ appDir, lane, date: startedAt }),
  );
  const bundle = {
    root,
    inlineDir: ensureDir(path.join(root, "inline")),
    logsDir: ensureDir(path.join(root, "logs")),
    rawDir: ensureDir(path.join(root, "raw")),
    reportsDir: ensureDir(path.join(root, "reports")),
    startedAt: startedAt.toISOString(),
    lane,
    device,
    build,
    steps: [],
    artifacts: [],
    warnings: [],
    _activeStep: null,
  };
  ensureDir(root);
  writeJson(path.join(root, "summary.json"), buildSummary(bundle, "running"));
  return bundle;
}

export function setBundleDevice(bundle, device) {
  bundle.device = { ...bundle.device, ...device };
  return bundle.device;
}

export function setBundleBuild(bundle, build) {
  bundle.build = { ...bundle.build, ...build };
  return bundle.build;
}

export function startBundleStep(bundle, name) {
  const step = {
    name,
    status: "running",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    artifacts: [],
  };
  bundle.steps.push(step);
  bundle._activeStep = step;
  return step;
}

export function finishBundleStep(bundle, step, status, error) {
  const endedAt = new Date();
  step.endedAt = endedAt.toISOString();
  step.durationMs = Math.max(0, endedAt.getTime() - Date.parse(step.startedAt));
  step.status = status;
  if (error) step.error = String(error?.message ?? error);
  if (bundle._activeStep === step) bundle._activeStep = null;
  return step;
}

export function failureDirForStep(bundle, step) {
  const slug = slugifyStepName(step.name) || "step";
  return ensureDir(path.join(bundle.root, "failure", slug));
}

export function recordBundleArtifact(bundle, filePath, kind, step = null) {
  const absolute = path.resolve(filePath);
  if (!isFile(absolute)) return null;
  const artifact = {
    kind,
    path: absolute,
    relativePath: path.relative(bundle.root, absolute),
    sizeBytes: fs.statSync(absolute).size,
  };
  bundle.artifacts.push(artifact);
  const owner = step ?? bundle._activeStep;
  if (owner) owner.artifacts.push(artifact.relativePath);
  return artifact;
}

export function captureFailureForensics(bundle, step, capture, error) {
  const failureDir = failureDirForStep(bundle, step);
  step.failureDir = path.relative(bundle.root, failureDir);
  try {
    const captured = capture({ failureDir, error }) ?? [];
    const files = Array.isArray(captured) ? captured : [captured];
    for (const file of files.filter(Boolean)) {
      const ext = path.extname(file).toLowerCase();
      const kind = VIDEO_EXTENSIONS.has(ext)
        ? "video"
        : IMAGE_EXTENSIONS.has(ext)
          ? "screenshot"
          : "log";
      recordBundleArtifact(bundle, file, kind, step);
    }
  } catch (captureError) {
    // error-policy:J6 failure forensics is teardown/diagnostic work; preserve
    // the original runner failure and record the capture problem as a warning.
    bundle.warnings.push(
      `failure forensics failed for ${step.name}: ${captureError?.message ?? captureError}`,
    );
  }
  return failureDir;
}

export function formatFailureForensicsBlock(bundle, error) {
  const failedStep = [...bundle.steps]
    .reverse()
    .find((step) => step.status === "failed");
  if (!failedStep) return "";
  const artifactPaths = failedStep.artifacts.map((relativePath) =>
    path.join(bundle.root, relativePath),
  );
  const lines = [
    "DEVICE E2E FAILURE FORENSICS",
    `step: ${failedStep.name}`,
    `cause: ${error?.message ?? failedStep.error ?? error}`,
  ];
  if (failedStep.failureDir) {
    lines.push(`failureDir: ${path.join(bundle.root, failedStep.failureDir)}`);
  }
  if (artifactPaths.length > 0) {
    lines.push("artifacts:");
    for (const artifactPath of artifactPaths) lines.push(`  - ${artifactPath}`);
  }
  return `${lines.join("\n")}\n`;
}

export function appendRunnerLog(bundle, chunk) {
  fs.appendFileSync(path.join(bundle.logsDir, "runner.log"), chunk);
}

export function runBundledCommand(
  bundle,
  name,
  cmd,
  args,
  { cwd, env = {}, onFailure } = {},
) {
  const step = startBundleStep(bundle, name);
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) {
    process.stdout.write(stdout);
    appendRunnerLog(bundle, stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
    appendRunnerLog(bundle, stderr);
  }
  const ok = result.status === 0;
  const failure = ok
    ? null
    : `${cmd} ${args.join(" ")} ${
        result.status === null
          ? "terminated by signal"
          : `exited with ${result.status}`
      }`;
  if (!ok && onFailure) onFailure(step, failure);
  finishBundleStep(bundle, step, ok ? "passed" : "failed", failure);
  if (!ok) {
    throw new Error(
      `${cmd} ${args.join(" ")} ${
        result.status === null
          ? "terminated by signal"
          : `exited with code ${result.status}`
      }`,
    );
  }
  return result;
}

export function collectBundleArtifacts(bundle, sourceDirs) {
  const seen = new Set(bundle.artifacts.map((artifact) => artifact.path));
  for (const sourceDir of sourceDirs.filter(Boolean)) {
    for (const file of walkFiles(sourceDir)) {
      const ext = path.extname(file).toLowerCase();
      if (seen.has(path.resolve(file))) continue;
      if (VIDEO_EXTENSIONS.has(ext)) {
        recordBundleArtifact(bundle, file, "video");
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        recordBundleArtifact(bundle, file, "screenshot");
      } else if (
        LOG_EXTENSIONS.has(ext) ||
        path.basename(file) === "junit.xml"
      ) {
        recordBundleArtifact(bundle, file, "log");
      }
      seen.add(path.resolve(file));
    }
  }
}

export function prepareInlineArtifacts(bundle) {
  for (const artifact of [...bundle.artifacts]) {
    const ext = path.extname(artifact.path).toLowerCase();
    if (INLINE_EXTENSIONS.has(ext)) {
      const dest = uniquePath(bundle.inlineDir, path.basename(artifact.path));
      if (path.resolve(artifact.path) !== path.resolve(dest)) {
        fs.copyFileSync(artifact.path, dest);
      }
      recordBundleArtifact(bundle, dest, artifact.kind);
      continue;
    }
    if (ext === ".png") {
      const dest = uniquePath(
        bundle.inlineDir,
        `${path.basename(artifact.path, ext)}.jpg`,
      );
      if (convertPngToJpg(artifact.path, dest)) {
        recordBundleArtifact(bundle, dest, "screenshot");
      } else {
        bundle.warnings.push(`could not convert PNG to JPG: ${artifact.path}`);
      }
      continue;
    }
    if (ext === ".mov") {
      const dest = uniquePath(
        bundle.inlineDir,
        `${path.basename(artifact.path, ext)}.mp4`,
      );
      if (remuxMovToMp4(artifact.path, dest)) {
        recordBundleArtifact(bundle, dest, "video");
      } else {
        bundle.warnings.push(`could not remux MOV to MP4: ${artifact.path}`);
      }
    }
  }
}

export function writeBundleJunit(bundle, result) {
  const failed = bundle.steps.filter((step) => step.status === "failed");
  const tests = bundle.steps.length || 1;
  const body =
    bundle.steps.length === 0
      ? `<testcase classname="${xmlEscape(bundle.lane)}" name="runner" />`
      : bundle.steps
          .map((step) => {
            const seconds = (step.durationMs / 1000).toFixed(3);
            const failure =
              step.status === "failed"
                ? `<failure message="${xmlEscape(step.error ?? "failed")}">${xmlEscape(step.error ?? "failed")}</failure>`
                : "";
            return `<testcase classname="${xmlEscape(bundle.lane)}" name="${xmlEscape(step.name)}" time="${seconds}">${failure}</testcase>`;
          })
          .join("\n");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="${xmlEscape(bundle.lane)}" tests="${tests}" failures="${failed.length}" errors="0" time="${(totalDurationMs(bundle) / 1000).toFixed(3)}" result="${xmlEscape(result)}">\n` +
    `${body}\n` +
    `</testsuite>\n`;
  const junitPath = path.join(bundle.root, "junit.xml");
  fs.writeFileSync(junitPath, xml);
  recordBundleArtifact(bundle, junitPath, "junit");
  return junitPath;
}

function totalDurationMs(bundle) {
  return bundle.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
}

function buildSummary(bundle, result) {
  return {
    lane: bundle.lane,
    startedAt: bundle.startedAt,
    finishedAt: new Date().toISOString(),
    device: bundle.device,
    build: bundle.build,
    steps: bundle.steps.map((step) => ({
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt ?? null,
      durationMs: step.durationMs,
      artifacts: step.artifacts,
      ...(step.failureDir ? { failureDir: step.failureDir } : {}),
      ...(step.error ? { error: step.error } : {}),
    })),
    artifacts: bundle.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.relativePath,
      sizeBytes: artifact.sizeBytes,
    })),
    warnings: bundle.warnings,
    result,
  };
}

export function finalizeDeviceE2eBundle(bundle, result) {
  collectBundleArtifacts(bundle, [
    bundle.rawDir,
    bundle.logsDir,
    bundle.reportsDir,
    path.join(bundle.root, "test-results"),
  ]);
  prepareInlineArtifacts(bundle);
  writeBundleJunit(bundle, result);
  writeJson(
    path.join(bundle.root, "summary.json"),
    buildSummary(bundle, result),
  );
  return bundle.root;
}
