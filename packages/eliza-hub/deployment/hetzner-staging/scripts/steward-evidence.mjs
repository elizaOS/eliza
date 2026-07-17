#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "readyProductionMode",
    envKey: "STEWARD_EVIDENCE_READY_PRODUCTION_MODE",
  },
  {
    outputKey: "labelMirroringTested",
    envKey: "STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED",
  },
  {
    outputKey: "botTokenPermissionsReviewed",
    envKey: "STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED",
  },
  {
    outputKey: "strictWorkReservationsEnforced",
    envKey: "MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS",
  },
  {
    outputKey: "strictWorkItemsEnforced",
    envKey: "MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS",
  },
  {
    outputKey: "strictAgentBranchNamespacesEnforced",
    envKey: "MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE",
  },
  {
    outputKey: "verifiedAgentRunReceiptsEnforced",
    envKey: "MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT",
  },
  {
    outputKey: "agentIdentityRegistryEnforced",
    envKey: "MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY",
  },
]);

const CONFIG_KEYS = Object.freeze([
  "STEWARD_EVIDENCE_PREFLIGHT_JSON",
  "STEWARD_EVIDENCE_DOCTOR_JSON",
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const preflightJsonPath =
      options.preflightJson ?? values.STEWARD_EVIDENCE_PREFLIGHT_JSON;
    const doctorJsonPath =
      options.doctorJson ?? values.STEWARD_EVIDENCE_DOCTOR_JSON;
    const preflightFragment = readJsonFragment(
      preflightJsonPath,
      "STEWARD_EVIDENCE_PREFLIGHT_JSON",
      errors,
    );
    const doctorFragment = readJsonFragment(
      doctorJsonPath,
      "STEWARD_EVIDENCE_DOCTOR_JSON",
      errors,
    );
    const normalizedPreflight = normalizePreflight(
      Object.hasOwn(preflightFragment, "preflight")
        ? preflightFragment.preflight
        : preflightFragment,
      errors,
    );
    const normalizedDoctor = normalizeDoctor(
      Object.hasOwn(doctorFragment, "doctor")
        ? doctorFragment.doctor
        : doctorFragment,
      errors,
    );
    const preflight = normalizedPreflight.preflight;
    const doctor = normalizedDoctor.doctor;
    const inferredReady =
      preflight.ok === true &&
      preflight.mode === "production" &&
      preflight.errors.length === 0 &&
      doctor.ok === true;
    const steward = {
      preflight,
      doctor,
      preflightEvidence: {
        source: preflightJsonPath ?? null,
        sha256: preflightJsonPath ? sha256File(preflightJsonPath) : null,
        checkedAt: normalizedPreflight.checkedAt,
        mode: preflight.mode,
        errorCount: preflight.errors.length,
      },
      doctorEvidence: {
        source: doctorJsonPath ?? null,
        sha256: doctorJsonPath ? sha256File(doctorJsonPath) : null,
        target: normalizedDoctor.target,
        checkedAt: normalizedDoctor.checkedAt,
        checkCount: normalizedDoctor.checkCount,
      },
    };

    for (const field of BOOLEAN_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      steward[field.outputKey] =
        field.outputKey === "readyProductionMode"
          ? (parsed ?? inferredReady)
          : (parsed ?? false);
    }

    validatePositiveEvidence(steward, errors);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[steward-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`${JSON.stringify({ steward }, null, 2)}\n`);
  } catch (error) {
    console.error(`[steward-evidence] error: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--env-file") {
      index += 1;
      if (!args[index]) {
        throw new Error("--env-file requires a path");
      }
      options.envFile = args[index];
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
      if (!options.envFile) {
        throw new Error("--env-file requires a path");
      }
      continue;
    }

    if (arg === "--preflight-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--preflight-json requires a path");
      }
      options.preflightJson = args[index];
      continue;
    }

    if (arg.startsWith("--preflight-json=")) {
      options.preflightJson = arg.slice("--preflight-json=".length);
      if (!options.preflightJson) {
        throw new Error("--preflight-json requires a path");
      }
      continue;
    }

    if (arg === "--doctor-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--doctor-json requires a path");
      }
      options.doctorJson = args[index];
      continue;
    }

    if (arg.startsWith("--doctor-json=")) {
      options.doctorJson = arg.slice("--doctor-json=".length);
      if (!options.doctorJson) {
        throw new Error("--doctor-json requires a path");
      }
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function readConfiguration(envFile, processEnv) {
  const fileValues = readEnvFile(envFile, processEnv.ALLOW_ENV_ONLY);
  const values = { ...fileValues };

  for (const key of inputKeys()) {
    if (processEnv[key] !== undefined) {
      values[key] = processEnv[key];
    }
  }

  return values;
}

function readEnvFile(envFile, allowEnvOnly) {
  if (!existsSync(envFile)) {
    if (parseBoolean(allowEnvOnly) === true) {
      return {};
    }
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  return parseEnv(readFileSync(envFile, "utf8"));
}

function inputKeys() {
  return [...CONFIG_KEYS, ...BOOLEAN_FIELDS.map((field) => field.envKey)];
}

function parseEnv(body) {
  const values = {};

  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(rawValue) {
  const value = rawValue.trimStart();

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted.replace(/\\([\\nrt"])/gu, (_, escaped) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return escaped;
      }
    });
  }

  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }

    if (value[index] === '"') {
      return index;
    }
  }

  return -1;
}

function readJsonFragment(filePath, label, errors) {
  const normalized = cleanValue(filePath);

  if (normalized === null) {
    return {};
  }

  if (!existsSync(normalized)) {
    errors.push(`${label} file does not exist`);
    return {};
  }

  try {
    const body = JSON.parse(readFileSync(normalized, "utf8"));
    return body && typeof body === "object" ? body : {};
  } catch (_error) {
    errors.push(`${label} must contain valid JSON`);
    return {};
  }
}

function normalizePreflight(value, errors) {
  const preflight = value && typeof value === "object" ? value : {};
  const ok = preflight.ok === true;
  const mode =
    typeof preflight.mode === "string" && preflight.mode.trim() !== ""
      ? preflight.mode
      : "unknown";
  const checkedAt = normalizeIso(preflight.checkedAt);
  const rawErrors = Array.isArray(preflight.errors) ? preflight.errors : [];
  const normalizedErrors = rawErrors.map((error) => {
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && typeof error.code === "string") {
      return { code: error.code };
    }
    return "unknown_error";
  });

  if (preflight.ok !== undefined && typeof preflight.ok !== "boolean") {
    errors.push("preflight.ok must be boolean");
  }
  if (!checkedAt) {
    errors.push(
      "preflight.checkedAt must be a valid timestamp from eliza-merge-steward preflight",
    );
  }

  return {
    preflight: { ok, mode, errors: normalizedErrors },
    checkedAt,
  };
}

function normalizeDoctor(value, errors) {
  const doctor = value && typeof value === "object" ? value : {};
  const checkedAt = normalizeIso(doctor.checkedAt);
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const target =
    typeof doctor.target === "string" && doctor.target.trim() !== ""
      ? doctor.target
      : null;

  if (doctor.ok !== undefined && typeof doctor.ok !== "boolean") {
    errors.push("doctor.ok must be boolean");
  }
  if (!checkedAt) {
    errors.push(
      "doctor.checkedAt must be a valid timestamp from eliza-merge-steward doctor",
    );
  }
  if (!target) {
    errors.push("doctor.target must identify the checked steward URL");
  }
  if (checks.length === 0) {
    errors.push("doctor.checks must include at least one deployment check");
  }

  return {
    doctor: { ok: doctor.ok === true },
    target,
    checkedAt,
    checkCount: checks.length,
  };
}

function validatePositiveEvidence(steward, errors) {
  if (steward.readyProductionMode && !steward.preflight.ok) {
    errors.push(
      "STEWARD_EVIDENCE_READY_PRODUCTION_MODE cannot be true until preflight.ok is true",
    );
  }

  if (steward.readyProductionMode && steward.preflight.mode !== "production") {
    errors.push(
      "STEWARD_EVIDENCE_READY_PRODUCTION_MODE cannot be true until preflight.mode is production",
    );
  }

  if (steward.readyProductionMode && steward.preflight.errors.length > 0) {
    errors.push(
      "STEWARD_EVIDENCE_READY_PRODUCTION_MODE cannot be true while preflight.errors is non-empty",
    );
  }

  if (steward.readyProductionMode && !steward.doctor.ok) {
    errors.push(
      "STEWARD_EVIDENCE_READY_PRODUCTION_MODE cannot be true until doctor.ok is true",
    );
  }

  if (steward.readyProductionMode && !steward.strictWorkReservationsEnforced) {
    errors.push(
      "MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS must be true when steward production mode is ready",
    );
  }

  if (steward.readyProductionMode && !steward.strictWorkItemsEnforced) {
    errors.push(
      "MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS must be true when steward production mode is ready",
    );
  }

  if (
    steward.readyProductionMode &&
    !steward.strictAgentBranchNamespacesEnforced
  ) {
    errors.push(
      "MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE must be true when steward production mode is ready",
    );
  }

  if (
    steward.readyProductionMode &&
    !steward.verifiedAgentRunReceiptsEnforced
  ) {
    errors.push(
      "MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT must be true when steward production mode is ready",
    );
  }

  if (steward.readyProductionMode && !steward.agentIdentityRegistryEnforced) {
    errors.push(
      "MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY must be true when steward production mode is ready",
    );
  }

  if (
    (steward.labelMirroringTested || steward.botTokenPermissionsReviewed) &&
    !steward.readyProductionMode
  ) {
    errors.push(
      "steward label and bot-token attestations require ready production mode",
    );
  }
}

function readBooleanAttestation(values, key, errors) {
  const parsed = parseBoolean(values[key]);

  if (parsed === undefined) {
    errors.push(`${key} must be true or false when set`);
    return false;
  }

  return parsed;
}

function parseBoolean(value) {
  const normalized = cleanValue(value);

  if (normalized === null) {
    return null;
  }

  if (TRUE_PATTERN.test(normalized)) {
    return true;
  }

  if (FALSE_PATTERN.test(normalized)) {
    return false;
  }

  return undefined;
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usage() {
  return `Usage: steward-evidence.mjs [--env-file PATH]
                            [--preflight-json PATH]
                            [--doctor-json PATH]

Prints a production evidence steward block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. Preflight and
doctor JSON are sanitized down to the production-gate fields.

Generate source JSON with:
  eliza-merge-steward preflight > $ELIZA_ARTIFACT_ROOT/steward-preflight.json
  eliza-merge-steward doctor <steward-url> > $ELIZA_ARTIFACT_ROOT/steward-doctor.json

Output files can be provided as arguments or env vars:
  STEWARD_EVIDENCE_PREFLIGHT_JSON
  STEWARD_EVIDENCE_DOCTOR_JSON

readyProductionMode is inferred when preflight is ok in production mode with no
errors and doctor.ok is true. Operator attestations default to false unless set:
  STEWARD_EVIDENCE_READY_PRODUCTION_MODE
  STEWARD_EVIDENCE_LABEL_MIRRORING_TESTED
  STEWARD_EVIDENCE_BOT_TOKEN_PERMISSIONS_REVIEWED
  MERGE_STEWARD_REQUIRE_WORK_RESERVATION_FOR_AGENT_PRS
  MERGE_STEWARD_REQUIRE_WORK_ITEM_FOR_AGENT_PRS
  MERGE_STEWARD_REQUIRE_AGENT_BRANCH_NAMESPACE
  MERGE_STEWARD_REQUIRE_VERIFIED_AGENT_RUN_RECEIPT
  MERGE_STEWARD_REQUIRE_AGENT_IDENTITY_REGISTRY
`;
}
