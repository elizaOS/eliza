/**
 * Device-e2e bundle assembly for the mobile runners.
 *
 * The runners exercise real devices and fail at many layers: build, install,
 * device boot, local agent startup, WebView driving, and cloud provisioning.
 * This module keeps those phases visible in one run directory even when the
 * process exits non-zero, and prepares inline-friendly evidence files for PR
 * comments without sending new output to the retired repo evidence tree.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isFinalizedMp4,
  isRenderableJpeg,
  resolveMediaProbeBinary,
} from "./device-video.mjs";

const require = createRequire(import.meta.url);

const INLINE_EXTENSIONS = new Set([".jpg", ".jpeg", ".mp4"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov"]);
const LOG_EXTENSIONS = new Set([".log", ".txt", ".json", ".jsonl"]);
const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

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
  if (isFile(root)) return [root];
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

function convertPngToJpg(src, dest) {
  if (process.platform === "darwin") {
    const sips = spawnSync(
      "sips",
      ["-s", "format", "jpeg", src, "--out", dest],
      { stdio: "ignore" },
    );
    if (sips.status === 0 && isNonEmptyFile(dest)) return true;
  }
  const ffmpegBinary = resolveMediaProbeBinary();
  if (ffmpegBinary) {
    // `-update 1` is required to write a single still to a fixed (non-pattern)
    // filename: without it the image2 muxer demands a `%d` sequence pattern and
    // older ffmpeg builds treat the missing pattern as a fatal error (non-zero
    // exit, no file). Newer builds only warn, so the flag keeps the conversion
    // deterministic across ffmpeg versions on the CI runners.
    const ffmpeg = spawnSync(
      ffmpegBinary,
      ["-y", "-i", src, "-frames:v", "1", "-update", "1", "-q:v", "2", dest],
      { stdio: "ignore" },
    );
    if (ffmpeg.status === 0 && isNonEmptyFile(dest)) return true;
  }
  return convertPngToJpgWithSharp(src, dest);
}

// Final PNG->JPG fallback for hosts without sips/ffmpeg — notably the Linux CI
// runners, which ship neither. `sharp` is a declared packages/app dependency,
// so it is always installed here; run it out-of-process to keep this converter
// synchronous like the sips/ffmpeg spawns above (prepareInlineArtifacts and
// every runner call site depend on the sync contract, and sharp's API is async
// only). Returns false if sharp cannot be resolved or the encode fails.
function convertPngToJpgWithSharp(src, dest) {
  let sharpEntry;
  try {
    sharpEntry = require.resolve("sharp");
  } catch {
    return false;
  }
  const encode =
    "const sharp=require(process.argv[3]);" +
    "sharp(process.argv[1]).jpeg({quality:82}).toFile(process.argv[2])" +
    ".then(()=>process.exit(0)).catch(()=>process.exit(1));";
  // Under `bun test` process.execPath is bun; loading sharp's NAPI binary
  // there has flaked on canary bun builds, so fall back to the system node
  // (which sharp targets first-class) before giving up.
  const runtimes =
    path.basename(process.execPath).startsWith("bun") === false
      ? [process.execPath]
      : [process.execPath, "node"];
  for (const runtime of runtimes) {
    const result = spawnSync(runtime, ["-e", encode, src, dest, sharpEntry], {
      stdio: "ignore",
    });
    if (result.status === 0 && isNonEmptyFile(dest)) return true;
  }
  return false;
}

function remuxMovToMp4(src, dest) {
  const ffmpegBinary = resolveMediaProbeBinary();
  if (!ffmpegBinary) return false;
  const result = spawnSync(
    ffmpegBinary,
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

export function resolveBundleExpectedCommit(
  appDir,
  { execFileSync: execFileSyncDep = execFileSync } = {},
) {
  try {
    const commit = execFileSyncDep("git", ["rev-parse", "HEAD"], {
      cwd: appDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return FULL_GIT_SHA.test(commit) ? commit.toLowerCase() : null;
  } catch {
    // error-policy:J3 A bundle without repository authority fails validation.
    return null;
  }
}

export function assertExactBundleCommit(actual, expected, label = "build") {
  const actualCommit = typeof actual === "string" ? actual.trim() : "";
  const expectedCommit = typeof expected === "string" ? expected.trim() : "";
  if (!FULL_GIT_SHA.test(expectedCommit)) {
    throw new Error("expected git commit is missing or is not a full SHA-1");
  }
  if (!FULL_GIT_SHA.test(actualCommit)) {
    throw new Error(`${label}.commit is missing or is not a full SHA-1`);
  }
  if (actualCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error(
      `${label}.commit ${actualCommit} does not match expected HEAD ${expectedCommit}`,
    );
  }
  return actualCommit.toLowerCase();
}

export function createDeviceE2eBundle({
  appDir,
  lane,
  outputDir,
  startedAt = new Date(),
  device = {},
  build = {},
  expectedCommit = resolveBundleExpectedCommit(appDir),
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
    expectedCommit,
    steps: [],
    artifacts: [],
    warnings: [],
    validationErrors: [],
    result: "running",
    _activeStep: null,
    _finalizationError: null,
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
  const sourcePath = path.resolve(filePath);
  if (!isFile(sourcePath)) return null;
  const sourceRelative = path.relative(bundle.root, sourcePath);
  const isExternal =
    sourceRelative === ".." ||
    sourceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(sourceRelative);
  let absolute = sourcePath;
  if (isExternal) {
    const destinationDir = kind === "log" ? bundle.logsDir : bundle.rawDir;
    absolute = uniquePath(destinationDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, absolute);
  }
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

export function recordBundleRunnerFailure(bundle, error) {
  const message = error?.message ?? error;
  appendRunnerLog(bundle, `runner failure: ${message}\n`);
  const activeStep = bundle._activeStep;
  if (activeStep?.status === "running") {
    finishBundleStep(bundle, activeStep, "failed", error);
    return activeStep;
  }
  const existingFailure = bundle.steps.find((step) => step.status === "failed");
  if (existingFailure) return existingFailure;
  const step = startBundleStep(bundle, "runner failure");
  return finishBundleStep(bundle, step, "failed", error);
}

export function runBundledCommand(
  bundle,
  name,
  cmd,
  args,
  { cwd, env = {}, onFailure, timeoutMs } = {},
) {
  const step = startBundleStep(bundle, name);
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
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
  const timedOut = result.error?.code === "ETIMEDOUT";
  const outcome = timedOut
    ? `timed out after ${timeoutMs}ms`
    : result.status === null
      ? `terminated by signal${result.signal ? ` ${result.signal}` : ""}`
      : `exited with code ${result.status}`;
  const failure = ok ? null : `${cmd} ${args.join(" ")} ${outcome}`;
  if (!ok && onFailure) onFailure(step, failure);
  finishBundleStep(bundle, step, ok ? "passed" : "failed", failure);
  if (!ok) {
    throw new Error(`${cmd} ${args.join(" ")} ${outcome}`);
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
      if (ext === ".mp4" && !isFinalizedMp4(artifact.path)) {
        bundle.warnings.push(
          `could not publish unfinalized MP4 inline: ${artifact.path}`,
        );
        continue;
      }
      if (
        (ext === ".jpg" || ext === ".jpeg") &&
        !isRenderableJpeg(artifact.path)
      ) {
        bundle.warnings.push(
          `could not publish unrenderable JPEG inline: ${artifact.path}`,
        );
        continue;
      }
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
    build: { ...bundle.build, expectedCommit: bundle.expectedCommit },
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
    validationErrors: bundle.validationErrors,
    result,
  };
}

function hasInlineArtifact(bundle, extensions) {
  return bundle.artifacts.some((artifact) => {
    const relativePath = artifact.relativePath.replaceAll(path.sep, "/");
    const extension = path.extname(artifact.path).toLowerCase();
    return (
      relativePath.startsWith("inline/") &&
      extensions.has(extension) &&
      (extension === ".mp4"
        ? isFinalizedMp4(artifact.path)
        : isRenderableJpeg(artifact.path))
    );
  });
}

function validateRequiredEvidence(bundle, requiredEvidence) {
  const findings = [];
  if (
    requiredEvidence.buildId &&
    (typeof bundle.build.buildId !== "string" ||
      bundle.build.buildId.trim().length === 0)
  ) {
    findings.push("build.buildId is missing");
  }
  if (requiredEvidence.commit) {
    try {
      assertExactBundleCommit(
        bundle.build.commit,
        bundle.expectedCommit,
        "build",
      );
    } catch (error) {
      findings.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (
    requiredEvidence.inlineScreenshot &&
    !hasInlineArtifact(bundle, new Set([".jpg", ".jpeg"]))
  ) {
    findings.push("inline JPG screenshot is missing");
  }
  if (
    requiredEvidence.inlineVideo &&
    !hasInlineArtifact(bundle, new Set([".mp4"]))
  ) {
    findings.push("inline MP4 walkthrough is missing");
  }
  if (
    requiredEvidence.logs &&
    !walkFiles(bundle.logsDir).some(isNonEmptyFile)
  ) {
    findings.push("logs/ has no non-empty log");
  }
  return findings;
}

export function getDeviceE2eBundleFinalizationError(bundle) {
  return bundle._finalizationError;
}

export function finalizeDeviceE2eBundle(
  bundle,
  result,
  { sourceDirs = [], requiredEvidence = {} } = {},
) {
  collectBundleArtifacts(bundle, [
    bundle.rawDir,
    bundle.logsDir,
    bundle.reportsDir,
    path.join(bundle.root, "test-results"),
    ...sourceDirs,
  ]);
  prepareInlineArtifacts(bundle);
  bundle.validationErrors = validateRequiredEvidence(bundle, requiredEvidence);
  let effectiveResult = result;
  bundle._finalizationError = null;
  if (result === "passed" && bundle.validationErrors.length > 0) {
    const message = `device evidence bundle is incomplete: ${bundle.validationErrors.join("; ")}`;
    const step = startBundleStep(bundle, "validate evidence bundle");
    finishBundleStep(bundle, step, "failed", message);
    effectiveResult = "failed";
    bundle._finalizationError = new Error(message);
  }
  bundle.result = effectiveResult;
  writeBundleJunit(bundle, effectiveResult);
  writeJson(
    path.join(bundle.root, "summary.json"),
    buildSummary(bundle, effectiveResult),
  );
  return bundle.root;
}
