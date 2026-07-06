// Shares script lib voice stage b eval helpers across repo automation entrypoints.
import fs from "node:fs";
import path from "node:path";

export const STAGE_B_SCHEMA = "eliza_voice_stage_b_stt_eval_v1";
export const STAGE_B_ISSUE = "9958";

export const REQUIRED_STAGE_B_BACKENDS = [
  {
    backend: "ios-sfspeechrecognizer",
    label: "iOS SFSpeechRecognizer",
    platforms: new Set(["ios"]),
    requiresBattery: true,
  },
  {
    backend: "android-speechrecognizer",
    label: "Android SpeechRecognizer",
    platforms: new Set(["android"]),
    requiresBattery: true,
  },
  {
    backend: "fused-asr",
    label: "Fused ASR",
    platforms: new Set(["linux", "macos", "macos-electrobun"]),
    requiresBattery: false,
  },
];

const AUDIO_SOURCES = new Set([
  "device-mic",
  "speaker-to-mic",
  "hardware-loopback",
  "real-fixture-replay",
]);
const MIN_UTTERANCES = 10;
const MIN_ACCEPT_RATE = 0.8;
const MAX_WORD_ERROR_RATE = 0.35;

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

function validateBattery(errors, label, battery) {
  if (!isObject(battery)) {
    errors.push(`${label}.battery is required for mobile Stage-B backends`);
    return;
  }
  const startPercent = getNumber(battery, ["startPercent", "start"]);
  const endPercent = getNumber(battery, ["endPercent", "end"]);
  const durationMinutes = getNumber(battery, [
    "durationMinutes",
    "minutes",
    "runtimeMinutes",
  ]);
  pushNumberError(
    errors,
    `${label}.battery.startPercent`,
    startPercent,
    (value) => value >= 0 && value <= 100,
    "between 0 and 100",
  );
  pushNumberError(
    errors,
    `${label}.battery.endPercent`,
    endPercent,
    (value) => value >= 0 && value <= 100,
    "between 0 and 100",
  );
  pushNumberError(
    errors,
    `${label}.battery.durationMinutes`,
    durationMinutes,
    (value) => value > 0,
    "greater than 0",
  );
}

function validatePower(errors, label, power) {
  if (!isObject(power)) {
    errors.push(`${label}.power is required for fused Stage-B power telemetry`);
    return;
  }
  const durationMinutes = getNumber(power, [
    "durationMinutes",
    "minutes",
    "runtimeMinutes",
  ]);
  const avgPowerWatts = getNumber(power, ["avgPowerWatts", "watts"]);
  const energyWh = getNumber(power, ["energyWh", "wattHours"]);
  pushNumberError(
    errors,
    `${label}.power.durationMinutes`,
    durationMinutes,
    (value) => value > 0,
    "greater than 0",
  );
  if (
    (typeof avgPowerWatts !== "number" || avgPowerWatts <= 0) &&
    (typeof energyWh !== "number" || energyWh <= 0)
  ) {
    errors.push(
      `${label}.power must include avgPowerWatts or energyWh greater than 0`,
    );
  }
}

function validateMetrics(errors, label, metrics) {
  if (!isObject(metrics)) {
    errors.push(`${label}.metrics is required`);
    return;
  }
  const utterances = getNumber(metrics, [
    "utterances",
    "totalUtterances",
    "total",
  ]);
  const trueAccepts = getNumber(metrics, ["trueAccepts"]);
  const falseAccepts = getNumber(metrics, ["falseAccepts"]);
  const acceptRate = getNumber(metrics, ["acceptRate"]);
  const wordErrorRate = getNumber(metrics, ["wordErrorRate", "wer"]);
  const msPerFrame = getNumber(metrics, ["msPerFrame", "millisecondsPerFrame"]);
  const latency = isObject(metrics.latencyMs) ? metrics.latencyMs : {};
  const p50 = getNumber(latency, ["p50", "median"]);
  const p95 = getNumber(latency, ["p95"]);
  const max = getNumber(latency, ["max", "p100"]);

  pushNumberError(
    errors,
    `${label}.metrics.utterances`,
    utterances,
    (value) => value >= MIN_UTTERANCES,
    `at least ${MIN_UTTERANCES}`,
  );
  pushNumberError(
    errors,
    `${label}.metrics.trueAccepts`,
    trueAccepts,
    (value) => value >= 0,
    "0 or greater",
  );
  pushNumberError(
    errors,
    `${label}.metrics.falseAccepts`,
    falseAccepts,
    (value) => value >= 0,
    "0 or greater",
  );
  pushNumberError(
    errors,
    `${label}.metrics.acceptRate`,
    acceptRate,
    (value) => value >= MIN_ACCEPT_RATE && value <= 1,
    `between ${MIN_ACCEPT_RATE} and 1`,
  );
  pushNumberError(
    errors,
    `${label}.metrics.wordErrorRate`,
    wordErrorRate,
    (value) => value >= 0 && value <= MAX_WORD_ERROR_RATE,
    `between 0 and ${MAX_WORD_ERROR_RATE}`,
  );
  pushNumberError(
    errors,
    `${label}.metrics.msPerFrame`,
    msPerFrame,
    (value) => value > 0,
    "greater than 0",
  );
  pushNumberError(
    errors,
    `${label}.metrics.latencyMs.p50`,
    p50,
    (value) => value > 0,
    "greater than 0",
  );
  pushNumberError(
    errors,
    `${label}.metrics.latencyMs.p95`,
    p95,
    (value) => value > 0,
    "greater than 0",
  );
  if (typeof p50 === "number" && typeof p95 === "number" && p95 < p50) {
    errors.push(`${label}.metrics.latencyMs.p95 must be >= p50`);
  }
  if (
    typeof p95 === "number" &&
    typeof max === "number" &&
    Number.isFinite(max) &&
    max < p95
  ) {
    errors.push(`${label}.metrics.latencyMs.max must be >= p95`);
  }
}

function validateRun(errors, run, requirement, context) {
  const label = `runs[${context.index}] ${requirement.backend}`;
  if (!isObject(run)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (run.realHardware !== true) {
    errors.push(`${label}.realHardware must be true`);
  }
  if (run.mocked === true || run.synthetic === true) {
    errors.push(`${label} must not be marked mocked/synthetic`);
  }
  if (!requirement.platforms.has(String(run.platform ?? ""))) {
    errors.push(
      `${label}.platform must be one of ${Array.from(requirement.platforms).join(", ")}`,
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

  validateMetrics(errors, label, run.metrics);
  if (requirement.requiresBattery) validateBattery(errors, label, run.battery);
  else validatePower(errors, label, run.power ?? run.battery);

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
}

export function resolveStageBReportPath(env = process.env) {
  const value = env.ELIZA_VOICE_STAGE_B_REPORT?.trim();
  return value ? path.resolve(value) : null;
}

export function defaultStageBOutputDir(
  env = process.env,
  repoRoot = process.cwd(),
) {
  if (env.ELIZA_VOICE_STAGE_B_OUT?.trim()) {
    return path.resolve(env.ELIZA_VOICE_STAGE_B_OUT.trim());
  }
  if (env.ELIZA_VOICE_MATRIX_OUT?.trim()) {
    return path.resolve(
      env.ELIZA_VOICE_MATRIX_OUT.trim(),
      env.ELIZA_VOICE_MATRIX_CELL_ID?.trim() || "stt.stage-b.evaluation",
    );
  }
  return path.resolve(
    repoRoot,
    "test-results",
    "evidence",
    `${STAGE_B_ISSUE}-voice-stage-b-evaluation`,
  );
}

export function readStageBReport(reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

export function validateStageBReport(report, options = {}) {
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
        requiredBackends: REQUIRED_STAGE_B_BACKENDS.length,
      },
    };
  }

  if (report.schema !== STAGE_B_SCHEMA) {
    errors.push(`schema must be ${STAGE_B_SCHEMA}`);
  }
  if (String(report.issue ?? "") !== STAGE_B_ISSUE) {
    errors.push(`issue must be ${STAGE_B_ISSUE}`);
  }
  validateIsoTimestamp(errors, "capturedAt", report.capturedAt);
  if (report.realHardware !== true) {
    errors.push("realHardware must be true");
  }
  if (report.mocked === true || report.synthetic === true) {
    errors.push("report must not be marked mocked/synthetic");
  }

  const runs = Array.isArray(report.runs) ? report.runs : [];
  if (runs.length === 0) {
    errors.push("runs must contain Stage-B backend results");
  }
  const runsByBackend = new Map();
  for (const [index, run] of runs.entries()) {
    const backend = isObject(run) ? getString(run, ["backend", "id"]) : null;
    if (!backend) {
      errors.push(`runs[${index}].backend is required`);
      continue;
    }
    if (runsByBackend.has(backend)) {
      errors.push(`runs contains duplicate backend ${backend}`);
    }
    runsByBackend.set(backend, { run, index });
  }

  const reportBuild = isObject(report.build) ? report.build : {};
  for (const requirement of REQUIRED_STAGE_B_BACKENDS) {
    const entry = runsByBackend.get(requirement.backend);
    if (!entry) {
      errors.push(
        `missing required Stage-B backend ${requirement.backend} (${requirement.label})`,
      );
      continue;
    }
    validateRun(errors, entry.run, requirement, {
      index: entry.index,
      reportPath,
      repoRoot,
      reportBuild,
    });
  }

  for (const backend of runsByBackend.keys()) {
    if (
      !REQUIRED_STAGE_B_BACKENDS.some(
        (requirement) => requirement.backend === backend,
      )
    ) {
      warnings.push(`ignoring non-required Stage-B backend ${backend}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      runCount: runs.length,
      requiredBackends: REQUIRED_STAGE_B_BACKENDS.length,
      checkedBackends: REQUIRED_STAGE_B_BACKENDS.map(
        (requirement) => requirement.backend,
      ),
    },
  };
}

export function renderStageBValidationMarkdown(result, options = {}) {
  const status = result.ok ? "PASS" : "FAIL";
  const lines = [
    "# Stage-B STT Evaluation Validation",
    "",
    `Status: ${status}`,
    options.reportPath ? `Report: ${options.reportPath}` : null,
    "",
    "## Required Backends",
    "",
    "| Backend | Platform | Telemetry |",
    "| --- | --- | --- |",
    ...REQUIRED_STAGE_B_BACKENDS.map(
      (backend) =>
        `| \`${backend.backend}\` | ${Array.from(backend.platforms).join(", ")} | ${
          backend.requiresBattery ? "battery" : "power"
        } |`,
    ),
    "",
    "## Result",
    "",
    `- Runs checked: ${result.summary.runCount}`,
    `- Required backends: ${result.summary.requiredBackends}`,
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
    "A passing report proves only the Stage-B STT evaluation artifact contract. The referenced artifacts still need reviewer inspection.",
    "",
  );
  return lines.join("\n");
}
