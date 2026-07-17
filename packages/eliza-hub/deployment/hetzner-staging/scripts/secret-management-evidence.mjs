#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const SECRET_GROUPS = Object.freeze([
  {
    outputKey: "appIniSecretsIssued",
    envKey: "SECRET_EVIDENCE_APP_INI_SECRETS_ISSUED",
    requirements: [
      { key: "FORGEJO_RECOVERY_ADMIN_PASSWORD", minLength: 24 },
      { key: "FORGEJO_DB_PASSWORD", minLength: 24 },
      { key: "FORGEJO_SECRET_KEY", minLength: 32 },
      { key: "FORGEJO_INTERNAL_TOKEN", minLength: 32 },
      { key: "FORGEJO_OAUTH2_JWT_SECRET", minLength: 32 },
    ],
  },
  {
    outputKey: "runnerTokenIssued",
    envKey: "SECRET_EVIDENCE_RUNNER_TOKEN_ISSUED",
    requirements: [{ key: "FORGEJO_RUNNER_REGISTRATION_TOKEN", minLength: 16 }],
  },
  {
    outputKey: "oauthSecretsIssued",
    envKey: "SECRET_EVIDENCE_OAUTH_SECRETS_ISSUED",
    requirements: [{ key: "ELIZA_CLOUD_FORGEJO_CLIENT_SECRET", minLength: 24 }],
  },
  {
    outputKey: "webhookSecretsIssued",
    envKey: "SECRET_EVIDENCE_WEBHOOK_SECRETS_ISSUED",
    requirements: [
      { key: "FORGEJO_STEWARD_TOKEN", minLength: 24 },
      { key: "FORGEJO_WEBHOOK_SECRET", minLength: 32 },
      { key: "MERGE_STEWARD_API_TOKEN", minLength: 24 },
    ],
  },
]);

const ATTESTATION_FIELDS = Object.freeze([
  {
    outputKey: "externalSecretStore",
    envKey: "SECRET_EVIDENCE_EXTERNAL_SECRET_STORE",
  },
  {
    outputKey: "rotationPolicyDocumented",
    envKey: "SECRET_EVIDENCE_ROTATION_POLICY_DOCUMENTED",
  },
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_SECRET_AUDIT_OUTPUT = artifactPath(
  "secret-management-audit.json",
);
const CONFIG_KEYS = Object.freeze(["SECRET_EVIDENCE_AUDIT_OUTPUT"]);

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, "../../..");
    const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const privateReferenceScan =
      options.privateReferenceScan ??
      process.env.PRIVATE_REFERENCE_SCAN ??
      path.resolve(repoRoot, "scripts", "private-reference-scan.sh");

    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const secrets = {};

    for (const field of ATTESTATION_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      secrets[field.outputKey] = parsed ?? false;
    }

    for (const group of SECRET_GROUPS) {
      const attested = readBooleanAttestation(values, group.envKey, errors);
      secrets[group.outputKey] =
        attested ??
        group.requirements.every((requirement) =>
          isIssuedSecret(values, requirement),
        );
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[secret-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!runPrivateReferenceScan(privateReferenceScan)) {
      console.error(
        "[secret-evidence] error: private reference scan failed; run scripts/private-reference-scan.sh for details",
      );
      process.exitCode = 1;
      return;
    }

    secrets.noPlaintextSecretsCommitted = true;
    const audit = secretManagementAudit(secrets);
    const outputPath =
      options.auditOutput ??
      values.SECRET_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_SECRET_AUDIT_OUTPUT;
    writeSecretAuditArtifact(outputPath, audit);
    secrets.secretEvidence = audit.productionReady
      ? {
          source: outputPath,
          sha256: sha256File(outputPath),
          checkedAt: audit.checkedAt,
          status: audit.status,
          productionReady: audit.productionReady,
          groupCount: audit.issuedGroups.length,
          checkCount: audit.checks.length,
        }
      : null;
    process.stdout.write(`${JSON.stringify({ secrets }, null, 2)}\n`);
  } catch (error) {
    console.error(`[secret-evidence] error: ${error.message}`);
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

    if (arg === "--private-reference-scan") {
      index += 1;
      if (!args[index]) {
        throw new Error("--private-reference-scan requires a path");
      }
      options.privateReferenceScan = args[index];
      continue;
    }

    if (arg.startsWith("--private-reference-scan=")) {
      options.privateReferenceScan = arg.slice(
        "--private-reference-scan=".length,
      );
      if (!options.privateReferenceScan) {
        throw new Error("--private-reference-scan requires a path");
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
    ...ATTESTATION_FIELDS.map((field) => field.envKey),
    ...SECRET_GROUPS.map((group) => group.envKey),
    ...SECRET_GROUPS.flatMap((group) =>
      group.requirements.map((requirement) => requirement.key),
    ),
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

function isIssuedSecret(values, requirement) {
  const value = cleanValue(values[requirement.key]);

  return (
    value !== null &&
    !hasBadPlaceholder(value) &&
    value.length >= requirement.minLength
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

function runPrivateReferenceScan(scanPath) {
  if (!existsSync(scanPath)) {
    throw new Error(`missing private reference scan: ${scanPath}`);
  }

  const result = spawnSync(scanPath, [], {
    cwd: path.resolve(path.dirname(scanPath), ".."),
    encoding: "utf8",
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return result.status === 0;
}

function secretManagementAudit(secrets) {
  const issuedGroups = SECRET_GROUPS.filter(
    (group) => secrets[group.outputKey] === true,
  ).map((group) => group.outputKey);
  const checks = [
    check("external_secret_store", secrets.externalSecretStore === true),
    check(
      "rotation_policy_documented",
      secrets.rotationPolicyDocumented === true,
    ),
    check("app_ini_secrets_issued", secrets.appIniSecretsIssued === true),
    check("runner_token_issued", secrets.runnerTokenIssued === true),
    check("oauth_secrets_issued", secrets.oauthSecretsIssued === true),
    check("webhook_secrets_issued", secrets.webhookSecretsIssued === true),
    check(
      "private_reference_scan_passed",
      secrets.noPlaintextSecretsCommitted === true,
    ),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt: new Date().toISOString(),
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    issuedGroups,
    evidence: {
      externalSecretStore: secrets.externalSecretStore,
      rotationPolicyDocumented: secrets.rotationPolicyDocumented,
      appIniSecretsIssued: secrets.appIniSecretsIssued,
      runnerTokenIssued: secrets.runnerTokenIssued,
      oauthSecretsIssued: secrets.oauthSecretsIssued,
      webhookSecretsIssued: secrets.webhookSecretsIssued,
      noPlaintextSecretsCommitted: secrets.noPlaintextSecretsCommitted,
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

function writeSecretAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ secretManagementAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usage() {
  return `Usage: secret-management-evidence.mjs [--env-file PATH] [--private-reference-scan PATH] [--audit-output PATH]

Prints a production evidence secrets block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. No secret values
are printed; errors report variable names only.

External attestations default to false unless set:
  SECRET_EVIDENCE_EXTERNAL_SECRET_STORE
  SECRET_EVIDENCE_ROTATION_POLICY_DOCUMENTED

Secret issuance can be inferred from non-placeholder private env values or
attested explicitly:
  SECRET_EVIDENCE_APP_INI_SECRETS_ISSUED
  SECRET_EVIDENCE_RUNNER_TOKEN_ISSUED
  SECRET_EVIDENCE_OAUTH_SECRETS_ISSUED
  SECRET_EVIDENCE_WEBHOOK_SECRETS_ISSUED

The helper always runs scripts/private-reference-scan.sh and sets
noPlaintextSecretsCommitted only when that scan passes.

Optional:
  SECRET_EVIDENCE_AUDIT_OUTPUT

The helper writes a retained local audit artifact to
SECRET_EVIDENCE_AUDIT_OUTPUT, --audit-output, or
$ELIZA_ARTIFACT_ROOT/secret-management-audit.json by default, then emits its
SHA-256 in secrets.secretEvidence.
`;
}
