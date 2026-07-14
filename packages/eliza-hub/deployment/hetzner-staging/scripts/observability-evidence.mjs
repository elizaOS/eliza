#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "prometheusScrapeOk",
    envKey: "OBSERVABILITY_EVIDENCE_PROMETHEUS_SCRAPE_OK",
  },
  {
    outputKey: "alertRulesLoaded",
    envKey: "OBSERVABILITY_EVIDENCE_ALERT_RULES_LOADED",
  },
  {
    outputKey: "alertRoutingConfigured",
    envKey: "OBSERVABILITY_EVIDENCE_ALERT_ROUTING_CONFIGURED",
  },
  {
    outputKey: "logsCollected",
    envKey: "OBSERVABILITY_EVIDENCE_LOGS_COLLECTED",
  },
  {
    outputKey: "noPageAlertsFiring",
    envKey: "OBSERVABILITY_EVIDENCE_NO_PAGE_ALERTS_FIRING",
  },
]);

const NUMBER_FIELDS = Object.freeze([
  {
    outputKey: "logRetentionDays",
    envKey: "OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS",
    min: 0,
  },
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const MIN_LOG_RETENTION_DAYS = 7;
const DEFAULT_OBSERVABILITY_AUDIT_OUTPUT = artifactPath(
  "observability-audit.json",
);
const CONFIG_KEYS = Object.freeze(["OBSERVABILITY_EVIDENCE_AUDIT_OUTPUT"]);

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
    const observability = {};

    for (const field of BOOLEAN_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      observability[field.outputKey] = parsed ?? false;
    }

    for (const field of NUMBER_FIELDS) {
      const parsed = readNumberAttestation(values, field, errors);
      observability[field.outputKey] = parsed ?? 0;
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[observability-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = observabilityAudit(observability);
    const outputPath =
      options.auditOutput ??
      values.OBSERVABILITY_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_OBSERVABILITY_AUDIT_OUTPUT;
    writeObservabilityAuditArtifact(outputPath, audit);
    observability.observabilityEvidence = audit.productionReady
      ? {
          source: outputPath,
          sha256: sha256File(outputPath),
          checkedAt: audit.checkedAt,
          status: audit.status,
          productionReady: audit.productionReady,
          checkCount: audit.checks.length,
        }
      : null;

    process.stdout.write(`${JSON.stringify({ observability }, null, 2)}\n`);
  } catch (error) {
    console.error(`[observability-evidence] error: ${error.message}`);
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
    ...BOOLEAN_FIELDS.map((field) => field.envKey),
    ...NUMBER_FIELDS.map((field) => field.envKey),
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

function readNumberAttestation(values, field, errors) {
  const normalized = cleanValue(values[field.envKey]);

  if (normalized === null) {
    return null;
  }

  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(normalized)) {
    errors.push(`${field.envKey} must be a number when set`);
    return 0;
  }

  const value = Number(normalized);
  if (value < field.min) {
    errors.push(`${field.envKey} must be at least ${field.min}`);
    return 0;
  }

  return value;
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

function observabilityAudit(observability) {
  const checks = [
    check("prometheus_scrape_ok", observability.prometheusScrapeOk === true),
    check("alert_rules_loaded", observability.alertRulesLoaded === true),
    check(
      "alert_routing_configured",
      observability.alertRoutingConfigured === true,
    ),
    check("logs_collected", observability.logsCollected === true),
    check(
      "log_retention_days_sufficient",
      observability.logRetentionDays >= MIN_LOG_RETENTION_DAYS,
    ),
    check("no_page_alerts_firing", observability.noPageAlertsFiring === true),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt: new Date().toISOString(),
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    evidence: {
      prometheusScrapeOk: observability.prometheusScrapeOk,
      alertRulesLoaded: observability.alertRulesLoaded,
      alertRoutingConfigured: observability.alertRoutingConfigured,
      logsCollected: observability.logsCollected,
      logRetentionDays: observability.logRetentionDays,
      noPageAlertsFiring: observability.noPageAlertsFiring,
    },
    checks,
  };
}

function check(name, passed) {
  return {
    name,
    status: passed ? "pass" : "fail",
  };
}

function writeObservabilityAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ observabilityAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usage() {
  return `Usage: observability-evidence.mjs [--env-file PATH] [--audit-output PATH]

Prints a production evidence observability block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Boolean attestations default to false unless set:
  OBSERVABILITY_EVIDENCE_PROMETHEUS_SCRAPE_OK
  OBSERVABILITY_EVIDENCE_ALERT_RULES_LOADED
  OBSERVABILITY_EVIDENCE_ALERT_ROUTING_CONFIGURED
  OBSERVABILITY_EVIDENCE_LOGS_COLLECTED
  OBSERVABILITY_EVIDENCE_NO_PAGE_ALERTS_FIRING

Numeric attestations default to 0 unless set:
  OBSERVABILITY_EVIDENCE_LOG_RETENTION_DAYS

Optional:
  OBSERVABILITY_EVIDENCE_AUDIT_OUTPUT

The helper writes a retained local audit artifact to
OBSERVABILITY_EVIDENCE_AUDIT_OUTPUT, --audit-output, or
$ELIZA_ARTIFACT_ROOT/observability-audit.json by default, then emits its
SHA-256 in observability.observabilityEvidence.
`;
}
