#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const DATABASE_FIELDS = Object.freeze([
  {
    outputKey: "forgejoPostgres",
    envKey: "DATABASE_EVIDENCE_FORGEJO_POSTGRES",
  },
  {
    outputKey: "stewardPostgres",
    envKey: "DATABASE_EVIDENCE_STEWARD_POSTGRES",
  },
  {
    outputKey: "migrationsApplied",
    envKey: "DATABASE_EVIDENCE_MIGRATIONS_APPLIED",
  },
  {
    outputKey: "emptyHostRestoreDrillPassed",
    envKey: "DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED",
  },
  {
    outputKey: "checksumDriftClean",
    envKey: "DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN",
  },
]);

const CONFIG_KEYS = Object.freeze([
  "MERGE_STEWARD_DATABASE_URL",
  "DATABASE_EVIDENCE_MIGRATION_OUTPUT",
  "DATABASE_EVIDENCE_RESTORE_DRILL_OUTPUT",
  "DATABASE_EVIDENCE_AUDIT_OUTPUT",
  "DATABASE_EVIDENCE_NOW",
]);

const EXPECTED_RESTORE_TABLES = Object.freeze([
  "steward_schema_migrations",
  "steward_queue_items",
  "steward_runs",
  "steward_events",
  "steward_agent_claims",
  "steward_worker_leases",
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_DATABASE_AUDIT_OUTPUT = artifactPath("database-audit.json");

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const deployDir = path.resolve(scriptDir, "..");
    const defaultEnvFile = path.resolve(deployDir, ".env");
    const defaultComposeFile = path.resolve(deployDir, "compose.yml");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const composeFile =
      options.composeFile ?? process.env.COMPOSE_FILE ?? defaultComposeFile;
    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const compose = readOptionalText(composeFile);
    const migrationOutputPath = cleanValue(
      options.migrationOutput ?? values.DATABASE_EVIDENCE_MIGRATION_OUTPUT,
    );
    const restoreDrillOutputPath = cleanValue(
      options.restoreDrillOutput ??
        values.DATABASE_EVIDENCE_RESTORE_DRILL_OUTPUT,
    );
    const migrationOutput = readOptionalText(
      migrationOutputPath,
      "DATABASE_EVIDENCE_MIGRATION_OUTPUT",
      errors,
    );
    const restoreDrillOutput = readOptionalText(
      restoreDrillOutputPath,
      "DATABASE_EVIDENCE_RESTORE_DRILL_OUTPUT",
      errors,
    );
    const checkedAt = normalizeTimestamp(
      values.DATABASE_EVIDENCE_NOW ?? new Date().toISOString(),
      "DATABASE_EVIDENCE_NOW",
      errors,
    );
    const inferred = {
      forgejoPostgres: forgejoPostgresConfigured(compose),
      stewardPostgres: stewardPostgresConfigured(values, compose),
      migrationsApplied: migrationOutputPassed(migrationOutput),
      emptyHostRestoreDrillPassed: restoreDrillPassed(restoreDrillOutput),
      checksumDriftClean: migrationOutputPassed(migrationOutput),
    };
    const database = {};

    for (const field of DATABASE_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      database[field.outputKey] = parsed ?? inferred[field.outputKey] ?? false;
    }

    validatePositiveEvidence(
      database,
      inferred,
      { migrationOutputPath, restoreDrillOutputPath },
      errors,
    );

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[database-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = databaseAudit({
      database,
      inferred,
      migrationOutputPath,
      restoreDrillOutputPath,
      checkedAt,
    });
    const outputPath =
      options.auditOutput ??
      values.DATABASE_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_DATABASE_AUDIT_OUTPUT;
    writeDatabaseAuditArtifact(outputPath, audit);
    database.databaseEvidence =
      audit.migrationOutput && audit.restoreDrillOutput
        ? {
            source: outputPath,
            sha256: sha256File(outputPath),
            checkedAt,
            status: audit.status,
            productionReady: audit.productionReady,
            migrationOutputSource: audit.migrationOutput.source,
            migrationOutputSha256: audit.migrationOutput.sha256,
            restoreDrillOutputSource: audit.restoreDrillOutput.source,
            restoreDrillOutputSha256: audit.restoreDrillOutput.sha256,
            checkCount: audit.checks.length,
            verifiedTableCount: audit.verifiedTables.length,
          }
        : null;

    process.stdout.write(`${JSON.stringify({ database }, null, 2)}\n`);
  } catch (error) {
    console.error(`[database-evidence] error: ${error.message}`);
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

    if (arg === "--compose-file") {
      index += 1;
      if (!args[index]) {
        throw new Error("--compose-file requires a path");
      }
      options.composeFile = args[index];
      continue;
    }

    if (arg.startsWith("--compose-file=")) {
      options.composeFile = arg.slice("--compose-file=".length);
      if (!options.composeFile) {
        throw new Error("--compose-file requires a path");
      }
      continue;
    }

    if (arg === "--migration-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--migration-output requires a path");
      }
      options.migrationOutput = args[index];
      continue;
    }

    if (arg.startsWith("--migration-output=")) {
      options.migrationOutput = arg.slice("--migration-output=".length);
      if (!options.migrationOutput) {
        throw new Error("--migration-output requires a path");
      }
      continue;
    }

    if (arg === "--restore-drill-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--restore-drill-output requires a path");
      }
      options.restoreDrillOutput = args[index];
      continue;
    }

    if (arg.startsWith("--restore-drill-output=")) {
      options.restoreDrillOutput = arg.slice("--restore-drill-output=".length);
      if (!options.restoreDrillOutput) {
        throw new Error("--restore-drill-output requires a path");
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
  return [...CONFIG_KEYS, ...DATABASE_FIELDS.map((field) => field.envKey)];
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

function readOptionalText(filePath, label, errors) {
  const normalized = cleanValue(filePath);

  if (normalized === null) {
    return "";
  }

  if (!existsSync(normalized)) {
    errors?.push(`${label} file does not exist`);
    return "";
  }

  try {
    return readFileSync(normalized, "utf8");
  } catch (error) {
    errors?.push(`${label} file cannot be read: ${error.message}`);
    return "";
  }
}

function forgejoPostgresConfigured(compose) {
  return (
    composeSetting(compose, "FORGEJO__database__DB_TYPE", "postgres") &&
    /^ {2}postgres:/mu.test(compose)
  );
}

function stewardPostgresConfigured(values, compose) {
  return (
    isPostgresUrl(values.MERGE_STEWARD_DATABASE_URL) &&
    /DATABASE_URL:\s*\$\{MERGE_STEWARD_DATABASE_URL/u.test(compose)
  );
}

function migrationOutputPassed(output) {
  if (output.trim() === "") {
    return false;
  }

  return (
    /\[MergeStewardMigrate\] complete/u.test(output) &&
    !/checksum mismatch|failed/i.test(output)
  );
}

function restoreDrillPassed(output) {
  if (!/restore drill passed/u.test(output)) {
    return false;
  }

  const verifiedTables = restoreDrillVerifiedTables(output);
  return EXPECTED_RESTORE_TABLES.every((table) =>
    verifiedTables.includes(table),
  );
}

function restoreDrillVerifiedTables(output) {
  const verifiedLine = /^verified_tables=(.+)$/mu.exec(output);
  if (!verifiedLine) {
    return [];
  }

  return verifiedLine[1]
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
}

function validatePositiveEvidence(database, inferred, sources, errors) {
  if (database.stewardPostgres && !inferred.stewardPostgres) {
    errors.push(
      "DATABASE_EVIDENCE_STEWARD_POSTGRES cannot be true until MERGE_STEWARD_DATABASE_URL is a postgres URL and Compose wires DATABASE_URL",
    );
  }

  if (database.migrationsApplied && !database.stewardPostgres) {
    errors.push(
      "DATABASE_EVIDENCE_MIGRATIONS_APPLIED cannot be true until steward Postgres is configured",
    );
  }

  if (database.checksumDriftClean && !database.migrationsApplied) {
    errors.push(
      "DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN cannot be true until migrations have been applied",
    );
  }

  if (
    database.emptyHostRestoreDrillPassed &&
    (!database.forgejoPostgres || !database.stewardPostgres)
  ) {
    errors.push(
      "DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED cannot be true until Forgejo and steward Postgres are configured",
    );
  }

  if (database.migrationsApplied && !sources.migrationOutputPath) {
    errors.push(
      "DATABASE_EVIDENCE_MIGRATIONS_APPLIED requires DATABASE_EVIDENCE_MIGRATION_OUTPUT or --migration-output",
    );
  }

  if (database.migrationsApplied && !inferred.migrationsApplied) {
    errors.push(
      "DATABASE_EVIDENCE_MIGRATIONS_APPLIED requires migration output containing [MergeStewardMigrate] complete and no checksum drift",
    );
  }

  if (database.checksumDriftClean && !inferred.checksumDriftClean) {
    errors.push(
      "DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN requires verified migration output with no checksum mismatch or failure",
    );
  }

  if (database.emptyHostRestoreDrillPassed && !sources.restoreDrillOutputPath) {
    errors.push(
      "DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED requires DATABASE_EVIDENCE_RESTORE_DRILL_OUTPUT or --restore-drill-output",
    );
  }

  if (
    database.emptyHostRestoreDrillPassed &&
    !inferred.emptyHostRestoreDrillPassed
  ) {
    errors.push(
      "DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED requires restore-drill output with all expected steward tables",
    );
  }
}

function composeSetting(compose, key, expectedValue) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedValue = expectedValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `${escapedKey}\\s*:\\s*(?:"${escapedValue}"|'${escapedValue}'|${escapedValue})(?:\\s|$)`,
    "u",
  );
  return pattern.test(compose);
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

function databaseAudit({
  database,
  inferred,
  migrationOutputPath,
  restoreDrillOutputPath,
  checkedAt,
}) {
  const migrationOutput = artifactEvidence(migrationOutputPath);
  const restoreDrillOutput = artifactEvidence(restoreDrillOutputPath);
  const verifiedTables = restoreDrillOutputPath
    ? restoreDrillVerifiedTables(readFileSync(restoreDrillOutputPath, "utf8"))
    : [];
  const evidence = {
    forgejoPostgres: database.forgejoPostgres,
    stewardPostgres: database.stewardPostgres,
    migrationsApplied: database.migrationsApplied,
    emptyHostRestoreDrillPassed: database.emptyHostRestoreDrillPassed,
    checksumDriftClean: database.checksumDriftClean,
  };
  const checks = [
    check(
      "forgejo_postgres_configured",
      database.forgejoPostgres === true && inferred.forgejoPostgres === true,
    ),
    check(
      "steward_postgres_configured",
      database.stewardPostgres === true && inferred.stewardPostgres === true,
    ),
    check(
      "migration_output_verified",
      database.migrationsApplied === true &&
        inferred.migrationsApplied === true,
      {
        source: migrationOutput?.source ?? null,
        sha256: migrationOutput?.sha256 ?? null,
      },
    ),
    check(
      "restore_drill_output_verified",
      database.emptyHostRestoreDrillPassed === true &&
        inferred.emptyHostRestoreDrillPassed === true,
      {
        source: restoreDrillOutput?.source ?? null,
        sha256: restoreDrillOutput?.sha256 ?? null,
        verifiedTables,
      },
    ),
    check(
      "checksum_drift_clean",
      database.checksumDriftClean === true &&
        inferred.checksumDriftClean === true,
    ),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt,
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    evidence,
    migrationOutput,
    restoreDrillOutput,
    verifiedTables,
    checks,
  };
}

function check(name, passed, details = {}) {
  return {
    name,
    status: passed ? "pass" : "fail",
    details,
  };
}

function artifactEvidence(filePath) {
  const normalized = cleanValue(filePath);
  if (!normalized) {
    return null;
  }

  return {
    source: normalized,
    sha256: sha256File(normalized),
  };
}

function writeDatabaseAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ databaseAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizeTimestamp(value, label, errors) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    errors.push(`${label} must be an ISO timestamp`);
    return null;
  }

  return new Date(time).toISOString();
}

function isPostgresUrl(value) {
  const normalized = cleanValue(value);

  if (normalized === null || hasBadPlaceholder(normalized)) {
    return false;
  }

  try {
    const url = new URL(normalized);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function hasBadPlaceholder(value) {
  const normalized = value.toLowerCase();

  return (
    normalized.includes("example.invalid") ||
    normalized.includes("replace-me") ||
    normalized === "dummy" ||
    normalized === "changeme" ||
    normalized === "change-me" ||
    normalized === "secret"
  );
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function usage() {
  return `Usage: database-evidence.mjs [--env-file PATH] [--compose-file PATH]
                             [--migration-output PATH]
                             [--restore-drill-output PATH]
                             [--audit-output PATH]

Prints a production evidence database block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. Database URLs are
used only for shape checks and are never printed.

forgejoPostgres is inferred from compose.yml when Forgejo uses Postgres.
stewardPostgres is inferred from MERGE_STEWARD_DATABASE_URL plus the Compose
DATABASE_URL wiring.

migrationsApplied and checksumDriftClean are inferred when migration output
contains "[MergeStewardMigrate] complete" and no checksum mismatch or failure.
emptyHostRestoreDrillPassed is inferred from restore-drill.sh output when it
contains "restore drill passed" and all expected steward tables.

Output files can be provided as arguments or env vars:
  DATABASE_EVIDENCE_MIGRATION_OUTPUT
  DATABASE_EVIDENCE_RESTORE_DRILL_OUTPUT
  DATABASE_EVIDENCE_AUDIT_OUTPUT

Boolean overrides default to false unless set:
  DATABASE_EVIDENCE_FORGEJO_POSTGRES
  DATABASE_EVIDENCE_STEWARD_POSTGRES
  DATABASE_EVIDENCE_MIGRATIONS_APPLIED
  DATABASE_EVIDENCE_EMPTY_HOST_RESTORE_DRILL_PASSED
  DATABASE_EVIDENCE_CHECKSUM_DRIFT_CLEAN

Optional:
  DATABASE_EVIDENCE_NOW

The helper writes a retained local audit artifact to DATABASE_EVIDENCE_AUDIT_OUTPUT,
--audit-output, or $ELIZA_ARTIFACT_ROOT/database-audit.json by default, then emits
its SHA-256 plus migration and restore-drill log digests in database.databaseEvidence.
`;
}
