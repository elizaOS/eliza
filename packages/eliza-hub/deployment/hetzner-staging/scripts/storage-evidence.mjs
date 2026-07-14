#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const STORAGE_FIELDS = Object.freeze([
  {
    outputKey: "sizingReviewed",
    envKey: "STORAGE_EVIDENCE_SIZING_REVIEWED",
  },
  {
    outputKey: "artifactRetentionConfigured",
    envKey: "STORAGE_EVIDENCE_ARTIFACT_RETENTION_CONFIGURED",
  },
  {
    outputKey: "packageRetentionConfigured",
    envKey: "STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED",
  },
  {
    outputKey: "lfsCapacityReviewed",
    envKey: "STORAGE_EVIDENCE_LFS_CAPACITY_REVIEWED",
  },
  {
    outputKey: "logRetentionConfigured",
    envKey: "STORAGE_EVIDENCE_LOG_RETENTION_CONFIGURED",
  },
]);

const RETENTION_KEYS = Object.freeze([
  "FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS",
  "FORGEJO_ACTION_LOG_RETENTION_DAYS",
]);
const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_STORAGE_AUDIT_OUTPUT = artifactPath(
  "storage-retention-audit.json",
);
const CONFIG_KEYS = Object.freeze(["STORAGE_EVIDENCE_AUDIT_OUTPUT"]);

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
    const storage = {};

    const inferred = {
      artifactRetentionConfigured: retentionConfigured(
        values.FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS,
      ),
      logRetentionConfigured: retentionConfigured(
        values.FORGEJO_ACTION_LOG_RETENTION_DAYS,
      ),
    };

    for (const field of STORAGE_FIELDS) {
      const attested = readBooleanAttestation(values, field.envKey, errors);
      storage[field.outputKey] = attested ?? inferred[field.outputKey] ?? false;
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[storage-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = storageAudit(storage, values);
    const outputPath =
      options.auditOutput ??
      values.STORAGE_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_STORAGE_AUDIT_OUTPUT;
    writeStorageAuditArtifact(outputPath, audit);
    storage.storageEvidence = audit.productionReady
      ? {
          source: outputPath,
          sha256: sha256File(outputPath),
          checkedAt: audit.checkedAt,
          status: audit.status,
          productionReady: audit.productionReady,
          checkCount: audit.checks.length,
        }
      : null;

    process.stdout.write(`${JSON.stringify({ storage }, null, 2)}\n`);
  } catch (error) {
    console.error(`[storage-evidence] error: ${error.message}`);
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

    if (arg === "--audit-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--audit-output requires a path");
      }
      options.auditOutput = args[index];
      continue;
    }

    if (arg.startsWith("--audit-output=")) {
      options.auditOutput = arg.slice("--audit-output=".length);
      if (!options.auditOutput) {
        throw new Error("--audit-output requires a path");
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
  return [
    ...CONFIG_KEYS,
    ...RETENTION_KEYS,
    ...STORAGE_FIELDS.map((field) => field.envKey),
  ];
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

function retentionConfigured(value) {
  const normalized = cleanValue(value);

  if (normalized === null || !/^[0-9]+$/u.test(normalized)) {
    return false;
  }

  const days = Number(normalized);
  return days >= 1 && days <= 90;
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function storageAudit(storage, values) {
  const artifactRetentionDays = parseRetentionDays(
    values.FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS,
  );
  const logRetentionDays = parseRetentionDays(
    values.FORGEJO_ACTION_LOG_RETENTION_DAYS,
  );
  const checks = [
    check("sizing_reviewed", storage.sizingReviewed === true),
    check(
      "artifact_retention_configured",
      storage.artifactRetentionConfigured === true,
    ),
    check(
      "package_retention_configured",
      storage.packageRetentionConfigured === true,
    ),
    check("lfs_capacity_reviewed", storage.lfsCapacityReviewed === true),
    check("log_retention_configured", storage.logRetentionConfigured === true),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt: new Date().toISOString(),
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    retention: {
      actionArtifactRetentionDays: artifactRetentionDays,
      actionLogRetentionDays: logRetentionDays,
    },
    evidence: {
      sizingReviewed: storage.sizingReviewed,
      artifactRetentionConfigured: storage.artifactRetentionConfigured,
      packageRetentionConfigured: storage.packageRetentionConfigured,
      lfsCapacityReviewed: storage.lfsCapacityReviewed,
      logRetentionConfigured: storage.logRetentionConfigured,
    },
    checks,
  };
}

function parseRetentionDays(value) {
  const normalized = cleanValue(value);
  if (normalized === null || !/^[0-9]+$/u.test(normalized)) return null;

  const days = Number(normalized);
  return days >= 1 && days <= 90 ? days : null;
}

function check(name, passed) {
  return {
    name,
    status: passed ? "pass" : "fail",
  };
}

function writeStorageAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ storageAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usage() {
  return `Usage: storage-evidence.mjs [--env-file PATH] [--audit-output PATH]

Prints a production evidence storage block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Action artifact and log retention are inferred from:
  FORGEJO_ACTION_ARTIFACT_RETENTION_DAYS
  FORGEJO_ACTION_LOG_RETENTION_DAYS

Capacity and non-action retention reviews must be attested explicitly:
  STORAGE_EVIDENCE_SIZING_REVIEWED
  STORAGE_EVIDENCE_PACKAGE_RETENTION_CONFIGURED
  STORAGE_EVIDENCE_LFS_CAPACITY_REVIEWED

Every output field can be explicitly attested or overridden:
  STORAGE_EVIDENCE_ARTIFACT_RETENTION_CONFIGURED
  STORAGE_EVIDENCE_LOG_RETENTION_CONFIGURED

Optional:
  STORAGE_EVIDENCE_AUDIT_OUTPUT

The helper writes a retained local audit artifact to
STORAGE_EVIDENCE_AUDIT_OUTPUT, --audit-output, or
$ELIZA_ARTIFACT_ROOT/storage-retention-audit.json by default, then emits its
SHA-256 in storage.storageEvidence.
`;
}
