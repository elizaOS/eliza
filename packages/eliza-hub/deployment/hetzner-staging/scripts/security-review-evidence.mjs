#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "authReviewed",
    envKey: "SECURITY_REVIEW_EVIDENCE_AUTH_REVIEWED",
  },
  {
    outputKey: "tokensReviewed",
    envKey: "SECURITY_REVIEW_EVIDENCE_TOKENS_REVIEWED",
  },
  {
    outputKey: "runnerExecutionReviewed",
    envKey: "SECURITY_REVIEW_EVIDENCE_RUNNER_EXECUTION_REVIEWED",
  },
  {
    outputKey: "repoPermissionsReviewed",
    envKey: "SECURITY_REVIEW_EVIDENCE_REPO_PERMISSIONS_REVIEWED",
  },
]);

const STRING_FIELDS = Object.freeze([
  {
    outputKey: "approvedBy",
    envKey: "SECURITY_REVIEW_EVIDENCE_APPROVED_BY",
  },
]);

const DATE_FIELDS = Object.freeze([
  {
    outputKey: "approvedAt",
    envKey: "SECURITY_REVIEW_EVIDENCE_APPROVED_AT",
  },
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_SECURITY_REVIEW_AUDIT_OUTPUT = artifactPath(
  "security-review-audit.json",
);
const CONFIG_KEYS = Object.freeze(["SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT"]);

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
    const securityReview = {};

    for (const field of BOOLEAN_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      securityReview[field.outputKey] = parsed ?? false;
    }

    for (const field of STRING_FIELDS) {
      securityReview[field.outputKey] = readStringAttestation(
        values,
        field.envKey,
      );
    }

    for (const field of DATE_FIELDS) {
      securityReview[field.outputKey] = readDateAttestation(
        values,
        field.envKey,
        errors,
      );
    }

    validatePositiveEvidence(securityReview, errors);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[security-review-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = securityReviewAudit(securityReview);
    const outputPath =
      options.auditOutput ??
      values.SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_SECURITY_REVIEW_AUDIT_OUTPUT;
    writeSecurityReviewAuditArtifact(outputPath, audit);
    securityReview.securityEvidence = audit.productionReady
      ? {
          source: outputPath,
          sha256: sha256File(outputPath),
          checkedAt: audit.checkedAt,
          status: audit.status,
          productionReady: audit.productionReady,
          approvedBy: audit.approvedBy,
          approvedAt: audit.approvedAt,
          checkCount: audit.checks.length,
          reviewedSurfaceCount: audit.reviewedSurfaces.length,
        }
      : null;

    process.stdout.write(`${JSON.stringify({ securityReview }, null, 2)}\n`);
  } catch (error) {
    console.error(`[security-review-evidence] error: ${error.message}`);
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
    ...STRING_FIELDS.map((field) => field.envKey),
    ...DATE_FIELDS.map((field) => field.envKey),
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

function validatePositiveEvidence(securityReview, errors) {
  const allReviewed =
    securityReview.authReviewed &&
    securityReview.tokensReviewed &&
    securityReview.runnerExecutionReviewed &&
    securityReview.repoPermissionsReviewed;
  const hasApproval =
    securityReview.approvedBy !== null || securityReview.approvedAt !== null;

  if (hasApproval && !allReviewed) {
    errors.push(
      "security review approval requires all security review attestations",
    );
  }

  if (
    securityReview.approvedBy !== null &&
    securityReview.approvedAt === null
  ) {
    errors.push(
      "SECURITY_REVIEW_EVIDENCE_APPROVED_AT is required when SECURITY_REVIEW_EVIDENCE_APPROVED_BY is set",
    );
  }

  if (
    securityReview.approvedAt !== null &&
    securityReview.approvedBy === null
  ) {
    errors.push(
      "SECURITY_REVIEW_EVIDENCE_APPROVED_BY is required when SECURITY_REVIEW_EVIDENCE_APPROVED_AT is set",
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

function readStringAttestation(values, key) {
  return cleanValue(values[key]);
}

function readDateAttestation(values, key, errors) {
  const normalized = cleanValue(values[key]);

  if (normalized === null) {
    return null;
  }

  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    errors.push(`${key} must be an ISO timestamp when set`);
    return null;
  }

  return new Date(timestamp).toISOString();
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

function securityReviewAudit(securityReview) {
  const reviewedSurfaces = BOOLEAN_FIELDS.filter(
    (field) => securityReview[field.outputKey] === true,
  ).map((field) => field.outputKey);
  const checks = [
    check("auth_reviewed", securityReview.authReviewed === true),
    check("tokens_reviewed", securityReview.tokensReviewed === true),
    check(
      "runner_execution_reviewed",
      securityReview.runnerExecutionReviewed === true,
    ),
    check(
      "repo_permissions_reviewed",
      securityReview.repoPermissionsReviewed === true,
    ),
    check("approved_by_recorded", securityReview.approvedBy !== null),
    check("approved_at_recorded", securityReview.approvedAt !== null),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt: securityReview.approvedAt,
    status: productionReady ? "approved" : "incomplete",
    productionReady,
    approvedBy: securityReview.approvedBy,
    approvedAt: securityReview.approvedAt,
    reviewedSurfaces,
    evidence: {
      authReviewed: securityReview.authReviewed,
      tokensReviewed: securityReview.tokensReviewed,
      runnerExecutionReviewed: securityReview.runnerExecutionReviewed,
      repoPermissionsReviewed: securityReview.repoPermissionsReviewed,
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

function writeSecurityReviewAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ securityReviewAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function usage() {
  return `Usage: security-review-evidence.mjs [--env-file PATH] [--audit-output PATH]

Prints a production evidence securityReview block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Operator attestations default to false/null unless set:
  SECURITY_REVIEW_EVIDENCE_AUTH_REVIEWED
  SECURITY_REVIEW_EVIDENCE_TOKENS_REVIEWED
  SECURITY_REVIEW_EVIDENCE_RUNNER_EXECUTION_REVIEWED
  SECURITY_REVIEW_EVIDENCE_REPO_PERMISSIONS_REVIEWED
  SECURITY_REVIEW_EVIDENCE_APPROVED_BY
  SECURITY_REVIEW_EVIDENCE_APPROVED_AT

Optional:
  SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT

The helper writes a retained local audit artifact to
SECURITY_REVIEW_EVIDENCE_AUDIT_OUTPUT, --audit-output, or
$ELIZA_ARTIFACT_ROOT/security-review-audit.json by default, then emits its
SHA-256 in securityReview.securityEvidence.
`;
}
