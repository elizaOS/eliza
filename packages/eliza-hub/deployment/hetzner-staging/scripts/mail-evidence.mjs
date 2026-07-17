#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const MAIL_FIELDS = Object.freeze([
  {
    outputKey: "smtpConfigured",
    envKey: "MAIL_EVIDENCE_SMTP_CONFIGURED",
  },
  {
    outputKey: "inviteSmokePassed",
    envKey: "MAIL_EVIDENCE_INVITE_SMOKE_PASSED",
  },
  {
    outputKey: "passwordResetSmokePassed",
    envKey: "MAIL_EVIDENCE_PASSWORD_RESET_SMOKE_PASSED",
  },
  {
    outputKey: "notificationSmokePassed",
    envKey: "MAIL_EVIDENCE_NOTIFICATION_SMOKE_PASSED",
  },
]);

const SMTP_KEYS = Object.freeze([
  "FORGEJO_MAIL_ENABLED",
  "FORGEJO_SMTP_ADDR",
  "FORGEJO_SMTP_PORT",
  "FORGEJO_MAIL_FROM",
  "FORGEJO_SMTP_USER",
  "FORGEJO_SMTP_PASSWORD",
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_MAIL_AUDIT_OUTPUT = artifactPath("mail-smoke-audit.json");
const CONFIG_KEYS = Object.freeze(["MAIL_EVIDENCE_AUDIT_OUTPUT"]);

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
    const mail = {};

    const mailEnabled = parseConfigBoolean(
      values.FORGEJO_MAIL_ENABLED,
      "FORGEJO_MAIL_ENABLED",
      errors,
    );
    const smtpConfigured = inferSmtpConfigured(values, mailEnabled);

    for (const field of MAIL_FIELDS) {
      const attested = readBooleanAttestation(values, field.envKey, errors);
      mail[field.outputKey] =
        field.outputKey === "smtpConfigured"
          ? (attested ?? smtpConfigured)
          : (attested ?? false);
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[mail-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = mailAudit(mail);
    const outputPath =
      options.auditOutput ??
      values.MAIL_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_MAIL_AUDIT_OUTPUT;
    writeMailAuditArtifact(outputPath, audit);
    mail.mailEvidence = audit.productionReady
      ? {
          source: outputPath,
          sha256: sha256File(outputPath),
          checkedAt: audit.checkedAt,
          status: audit.status,
          productionReady: audit.productionReady,
          checkCount: audit.checks.length,
        }
      : null;

    process.stdout.write(`${JSON.stringify({ mail }, null, 2)}\n`);
  } catch (error) {
    console.error(`[mail-evidence] error: ${error.message}`);
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
    ...SMTP_KEYS,
    ...MAIL_FIELDS.map((field) => field.envKey),
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

function parseConfigBoolean(value, key, errors) {
  const parsed = parseBoolean(value);

  if (parsed === undefined) {
    errors.push(`${key} must be true or false when set`);
    return false;
  }

  return parsed ?? false;
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

function inferSmtpConfigured(values, mailEnabled) {
  return (
    mailEnabled === true &&
    isPresent(values.FORGEJO_SMTP_ADDR) &&
    isValidPort(values.FORGEJO_SMTP_PORT) &&
    isEmail(values.FORGEJO_MAIL_FROM) &&
    isPresent(values.FORGEJO_SMTP_USER) &&
    isIssuedSecret(values.FORGEJO_SMTP_PASSWORD, 12)
  );
}

function isPresent(value) {
  const normalized = cleanValue(value);
  return normalized !== null && !hasBadPlaceholder(normalized);
}

function isIssuedSecret(value, minLength) {
  const normalized = cleanValue(value);
  return (
    normalized !== null &&
    !hasBadPlaceholder(normalized) &&
    normalized.length >= minLength
  );
}

function isValidPort(value) {
  const normalized = cleanValue(value);

  if (normalized === null || !/^[0-9]+$/u.test(normalized)) {
    return false;
  }

  const port = Number(normalized);
  return port >= 1 && port <= 65535;
}

function isEmail(value) {
  const normalized = cleanValue(value);
  return (
    normalized !== null &&
    !/\s/u.test(normalized) &&
    normalized.includes("@") &&
    normalized.includes(".")
  );
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

function mailAudit(mail) {
  const checks = [
    check("smtp_configured", mail.smtpConfigured === true),
    check("invite_smoke_passed", mail.inviteSmokePassed === true),
    check(
      "password_reset_smoke_passed",
      mail.passwordResetSmokePassed === true,
    ),
    check("notification_smoke_passed", mail.notificationSmokePassed === true),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt: new Date().toISOString(),
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    evidence: {
      smtpConfigured: mail.smtpConfigured,
      inviteSmokePassed: mail.inviteSmokePassed,
      passwordResetSmokePassed: mail.passwordResetSmokePassed,
      notificationSmokePassed: mail.notificationSmokePassed,
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

function writeMailAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ mailAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usage() {
  return `Usage: mail-evidence.mjs [--env-file PATH] [--audit-output PATH]

Prints a production evidence mail block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. No SMTP password
or other secret value is printed.

smtpConfigured is inferred when Forgejo mail is enabled and SMTP settings are
complete, or can be attested explicitly:
  MAIL_EVIDENCE_SMTP_CONFIGURED

Smoke-test booleans default to false unless set:
  MAIL_EVIDENCE_INVITE_SMOKE_PASSED
  MAIL_EVIDENCE_PASSWORD_RESET_SMOKE_PASSED
  MAIL_EVIDENCE_NOTIFICATION_SMOKE_PASSED

Optional:
  MAIL_EVIDENCE_AUDIT_OUTPUT

The helper writes a retained local audit artifact to
MAIL_EVIDENCE_AUDIT_OUTPUT, --audit-output, or
$ELIZA_ARTIFACT_ROOT/mail-smoke-audit.json by default, then emits its SHA-256
in mail.mailEvidence.
`;
}
