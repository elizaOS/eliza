// Shares script lib voice openwakeword eval helpers across repo automation entrypoints.
import fs from "node:fs";
import path from "node:path";

export const OPENWAKEWORD_SCHEMA = "eliza_voice_openwakeword_eval_v1";
export const OPENWAKEWORD_ISSUE = "9958";

export const REQUIRED_OPENWAKEWORD_CASES = [
  {
    caseId: "idle-wake",
    label: "idle wake opens the listen window",
    checks: ["wakeEvents", "listenWindowOpened", "latencyMs"],
  },
  {
    caseId: "already-listening-wake-inert",
    label: "wake while already listening is inert",
    checks: ["wakeEvents", "listenWindowOpenedFalse", "duplicateWindowCount"],
  },
  {
    caseId: "mid-transcription-wake",
    label: "wake during transcription does not corrupt transcript",
    checks: ["wakeEvents", "transcriptCorruptedFalse", "droppedTokens"],
  },
];

const ALLOWED_PLATFORMS = new Set([
  "android",
  "linux",
  "macos",
  "macos-electrobun",
]);
const AUDIO_SOURCES = new Set([
  "device-mic",
  "speaker-to-mic",
  "hardware-loopback",
  "real-fixture-replay",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNumber(source, keys) {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function getString(source, keys) {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pushNumberError(errors, label, value, predicate, hint) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !predicate(value)
  ) {
    errors.push(`${label} must be ${hint}`);
  }
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function artifactPathExists(artifactPath, reportPath, repoRoot) {
  if (isUrl(artifactPath)) return true;
  const candidates = [];
  if (path.isAbsolute(artifactPath)) candidates.push(artifactPath);
  else {
    if (reportPath)
      candidates.push(path.resolve(path.dirname(reportPath), artifactPath));
    if (repoRoot) candidates.push(path.resolve(repoRoot, artifactPath));
    candidates.push(path.resolve(process.cwd(), artifactPath));
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function validateIsoTimestamp(errors, label, value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO timestamp`);
  }
}

function validateArtifact(errors, artifact, context) {
  if (!isObject(artifact)) {
    errors.push(
      `${context.label}.artifacts[${context.index}] must be an object`,
    );
    return;
  }
  const artifactKind = getString(artifact, ["kind", "type"]);
  const artifactPath = getString(artifact, ["path", "href", "url"]);
  if (!artifactKind) {
    errors.push(
      `${context.label}.artifacts[${context.index}].kind is required`,
    );
  }
  if (!artifactPath) {
    errors.push(
      `${context.label}.artifacts[${context.index}].path is required`,
    );
  } else if (
    !artifactPathExists(artifactPath, context.reportPath, context.repoRoot)
  ) {
    errors.push(
      `${context.label}.artifacts[${context.index}].path does not exist: ${artifactPath}`,
    );
  }
  if (artifact.reviewed !== true) {
    errors.push(
      `${context.label}.artifacts[${context.index}].reviewed must be true after manual review`,
    );
  }
}

function validateCommonRun(errors, run, requirement, context) {
  const label = `runs[${context.index}] ${requirement.caseId}`;
  if (!isObject(run)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  if (run.realHardware !== true) {
    errors.push(`${label}.realHardware must be true`);
  }
  if (run.realHead !== true && run.realOpenWakeWordHead !== true) {
    errors.push(`${label}.realHead must be true`);
  }
  if (run.mocked === true || run.synthetic === true) {
    errors.push(`${label} must not be marked mocked/synthetic`);
  }
  if (!ALLOWED_PLATFORMS.has(String(run.platform ?? ""))) {
    errors.push(
      `${label}.platform must be one of ${Array.from(ALLOWED_PLATFORMS).join(", ")}`,
    );
  }

  const device = isObject(run.device) ? run.device : {};
  if (!getString(device, ["name", "model", "hardwareModel"])) {
    errors.push(`${label}.device.name or model is required`);
  }
  if (!getString(device, ["osVersion", "runtime", "kernel"])) {
    errors.push(`${label}.device.osVersion/runtime/kernel is required`);
  }

  const build = isObject(run.build) ? run.build : context.reportBuild;
  if (!getString(build, ["gitSha", "sha", "revision"])) {
    errors.push(`${label}.build.gitSha is required`);
  }

  const head = isObject(run.openWakeWord)
    ? run.openWakeWord
    : isObject(run.wakeHead)
      ? run.wakeHead
      : {};
  if (!getString(head, ["model", "modelName", "head"])) {
    errors.push(`${label}.openWakeWord.model is required`);
  }
  pushNumberError(
    errors,
    `${label}.openWakeWord.threshold`,
    getNumber(head, ["threshold", "scoreThreshold"]),
    (value) => value > 0 && value <= 1,
    "between 0 and 1",
  );

  const audio = isObject(run.audio) ? run.audio : {};
  const source = getString(audio, ["source"]);
  if (!source || !AUDIO_SOURCES.has(source)) {
    errors.push(
      `${label}.audio.source must be one of ${Array.from(AUDIO_SOURCES).join(", ")}`,
    );
  }
  pushNumberError(
    errors,
    `${label}.audio.durationSeconds`,
    getNumber(audio, ["durationSeconds", "seconds"]),
    (value) => value > 0,
    "greater than 0",
  );

  if (!Array.isArray(run.artifacts) || run.artifacts.length === 0) {
    errors.push(`${label}.artifacts must list manually reviewed evidence`);
  } else {
    run.artifacts.forEach((artifact, artifactIndex) => {
      validateArtifact(errors, artifact, {
        index: artifactIndex,
        label,
        reportPath: context.reportPath,
        repoRoot: context.repoRoot,
      });
    });
  }

  return label;
}

function observationsFor(run) {
  if (isObject(run.observations)) return run.observations;
  if (isObject(run.metrics)) return run.metrics;
  return {};
}

function validateCaseObservations(errors, run, requirement, context) {
  const label = validateCommonRun(errors, run, requirement, context);
  if (!label) return;
  const observations = observationsFor(run);
  const wakeEvents = getNumber(observations, [
    "wakeEvents",
    "wakeEventCount",
    "detections",
  ]);
  pushNumberError(
    errors,
    `${label}.observations.wakeEvents`,
    wakeEvents,
    (value) => value >= 1,
    "at least 1",
  );

  if (requirement.caseId === "idle-wake") {
    if (observations.listenWindowOpened !== true) {
      errors.push(`${label}.observations.listenWindowOpened must be true`);
    }
    pushNumberError(
      errors,
      `${label}.observations.latencyMs`,
      getNumber(observations, ["latencyMs", "wakeToListenWindowMs"]),
      (value) => value > 0,
      "greater than 0",
    );
    return;
  }

  if (requirement.caseId === "already-listening-wake-inert") {
    if (observations.listenWindowOpened !== false) {
      errors.push(`${label}.observations.listenWindowOpened must be false`);
    }
    pushNumberError(
      errors,
      `${label}.observations.duplicateWindowCount`,
      getNumber(observations, ["duplicateWindowCount", "extraWindows"]),
      (value) => value === 0,
      "0",
    );
    return;
  }

  if (requirement.caseId === "mid-transcription-wake") {
    if (observations.transcriptCorrupted !== false) {
      errors.push(`${label}.observations.transcriptCorrupted must be false`);
    }
    pushNumberError(
      errors,
      `${label}.observations.droppedTokens`,
      getNumber(observations, ["droppedTokens", "droppedTokenCount"]),
      (value) => value === 0,
      "0",
    );
  }
}

export function resolveOpenWakeWordReportPath(env = process.env) {
  const value = env.ELIZA_VOICE_OPENWAKEWORD_REPORT?.trim();
  return value ? path.resolve(value) : null;
}

export function defaultOpenWakeWordOutputDir(
  env = process.env,
  repoRoot = process.cwd(),
) {
  if (env.ELIZA_VOICE_OPENWAKEWORD_OUT?.trim()) {
    return path.resolve(env.ELIZA_VOICE_OPENWAKEWORD_OUT.trim());
  }
  if (env.ELIZA_VOICE_MATRIX_OUT?.trim()) {
    return path.resolve(
      env.ELIZA_VOICE_MATRIX_OUT.trim(),
      env.ELIZA_VOICE_MATRIX_CELL_ID?.trim() || "wake.openwakeword.real-head",
    );
  }
  return path.resolve(
    repoRoot,
    ".github",
    "issue-evidence",
    `${OPENWAKEWORD_ISSUE}-voice-openwakeword-evaluation`,
  );
}

export function readOpenWakeWordReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

export function validateOpenWakeWordReport(report, options = {}) {
  const errors = [];
  const warnings = [];
  const reportPath = options.reportPath
    ? path.resolve(options.reportPath)
    : null;
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : process.cwd();

  if (!isObject(report)) {
    return {
      ok: false,
      errors: ["report must be a JSON object"],
      warnings,
      summary: {
        runCount: 0,
        requiredCases: REQUIRED_OPENWAKEWORD_CASES.length,
      },
    };
  }

  if (report.schema !== OPENWAKEWORD_SCHEMA) {
    errors.push(`schema must be ${OPENWAKEWORD_SCHEMA}`);
  }
  if (String(report.issue ?? "") !== OPENWAKEWORD_ISSUE) {
    errors.push(`issue must be ${OPENWAKEWORD_ISSUE}`);
  }
  validateIsoTimestamp(errors, "capturedAt", report.capturedAt);
  if (report.realHardware !== true) errors.push("realHardware must be true");
  if (report.realHead !== true && report.realOpenWakeWordHead !== true) {
    errors.push("realHead must be true");
  }
  if (report.mocked === true || report.synthetic === true) {
    errors.push("report must not be marked mocked/synthetic");
  }

  const runs = Array.isArray(report.runs) ? report.runs : [];
  if (runs.length === 0) errors.push("runs must contain openWakeWord cases");
  const runsByCase = new Map();
  for (const [index, run] of runs.entries()) {
    const caseId = isObject(run)
      ? getString(run, ["case", "caseId", "id"])
      : null;
    if (!caseId) {
      errors.push(`runs[${index}].case is required`);
      continue;
    }
    if (runsByCase.has(caseId))
      errors.push(`runs contains duplicate case ${caseId}`);
    runsByCase.set(caseId, { run, index });
  }

  const reportBuild = isObject(report.build) ? report.build : {};
  for (const requirement of REQUIRED_OPENWAKEWORD_CASES) {
    const entry = runsByCase.get(requirement.caseId);
    if (!entry) {
      errors.push(
        `missing required openWakeWord case ${requirement.caseId} (${requirement.label})`,
      );
      continue;
    }
    validateCaseObservations(errors, entry.run, requirement, {
      index: entry.index,
      reportPath,
      repoRoot,
      reportBuild,
    });
  }

  for (const caseId of runsByCase.keys()) {
    if (
      !REQUIRED_OPENWAKEWORD_CASES.some(
        (requirement) => requirement.caseId === caseId,
      )
    ) {
      warnings.push(`ignoring non-required openWakeWord case ${caseId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      runCount: runs.length,
      requiredCases: REQUIRED_OPENWAKEWORD_CASES.length,
      checkedCases: REQUIRED_OPENWAKEWORD_CASES.map(
        (requirement) => requirement.caseId,
      ),
    },
  };
}

export function renderOpenWakeWordValidationMarkdown(result, options = {}) {
  const status = result.ok ? "PASS" : "FAIL";
  const lines = [
    "# openWakeWord Real-Head Validation",
    "",
    `Status: ${status}`,
    options.reportPath ? `Report: ${options.reportPath}` : null,
    "",
    "## Required Cases",
    "",
    "| Case | Expected proof |",
    "| --- | --- |",
    ...REQUIRED_OPENWAKEWORD_CASES.map(
      (item) => `| \`${item.caseId}\` | ${item.label} |`,
    ),
    "",
    "## Result",
    "",
    `- Runs checked: ${result.summary.runCount}`,
    `- Required cases: ${result.summary.requiredCases}`,
  ].filter((line) => line !== null);

  if (result.errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const error of result.errors) lines.push(`- ${error}`);
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  lines.push(
    "",
    "A passing report proves only the openWakeWord evidence artifact contract. The referenced recordings, logs, and transcripts still need reviewer inspection.",
    "",
  );
  return lines.join("\n");
}
