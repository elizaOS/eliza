#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath } from "./artifact-paths.mjs";

const DEFAULT_OUTPUT = artifactPath("sso-smoke.json");
const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;

const REQUIRED_SMOKE_CHECKS = Object.freeze([
  {
    key: "oidcLoginSucceeded",
    envKey: "SSO_SMOKE_OIDC_LOGIN_SUCCEEDED",
    aliases: ["SSO_SMOKE_LOGIN_SUCCEEDED", "SSO_SMOKE_BROWSER_SIGN_IN_PASSED"],
  },
  {
    key: "humanIdentitySmokePassed",
    envKey: "SSO_SMOKE_HUMAN_IDENTITY_SMOKE_PASSED",
    aliases: [
      "SSO_SMOKE_HUMAN_LOGIN_SUCCEEDED",
      "SSO_SMOKE_HUMAN_CLAIMS_VERIFIED",
    ],
  },
  {
    key: "agentIdentitySmokePassed",
    envKey: "SSO_SMOKE_AGENT_IDENTITY_SMOKE_PASSED",
    aliases: [
      "SSO_SMOKE_AGENT_TOKEN_CLAIMS_VERIFIED",
      "SSO_SMOKE_AGENT_CLAIMS_VERIFIED",
    ],
  },
  {
    key: "serviceIdentitySmokePassed",
    envKey: "SSO_SMOKE_SERVICE_IDENTITY_SMOKE_PASSED",
    aliases: [
      "SSO_SMOKE_SERVICE_TOKEN_CLAIMS_VERIFIED",
      "SSO_SMOKE_SERVICE_CLAIMS_VERIFIED",
    ],
  },
  {
    key: "publicRegistrationLocked",
    envKey: "SSO_SMOKE_PUBLIC_REGISTRATION_LOCKED",
    aliases: ["SSO_SMOKE_REGISTRATION_LOCKED"],
  },
  {
    key: "nonIssuerRejected",
    envKey: "SSO_SMOKE_NON_ISSUER_REJECTED",
    aliases: [
      "SSO_SMOKE_ISSUER_RESTRICTED",
      "SSO_SMOKE_AUTO_CREATE_RESTRICTED_TO_ISSUER",
    ],
  },
  {
    key: "recoveryAdminLoginSucceeded",
    envKey: "SSO_SMOKE_RECOVERY_ADMIN_LOGIN_SUCCEEDED",
    aliases: ["SSO_SMOKE_RECOVERY_ADMIN_VERIFIED"],
  },
]);

const OPTIONAL_CONTEXT_FIELDS = Object.freeze([
  ["humanSubject", "SSO_SMOKE_HUMAN_SUBJECT"],
  ["agentSubject", "SSO_SMOKE_AGENT_SUBJECT"],
  ["serviceSubject", "SSO_SMOKE_SERVICE_SUBJECT"],
  ["forgejoRootUrl", "FORGEJO_ROOT_URL"],
  ["notes", "SSO_SMOKE_NOTES"],
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
  const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
  const values = readConfiguration(envFile, process.env, {
    allowEnvOnly: options.allowEnvOnly,
  });
  const output =
    options.output ??
    values.SSO_SMOKE_OUTPUT ??
    values.SSO_SMOKE_EVIDENCE_OUTPUT ??
    DEFAULT_OUTPUT;
  const allowFailed =
    options.allowFailed ||
    parseBoolean(values.SSO_SMOKE_ALLOW_FAILED, false) === true;
  const checkedAt = normalizeIso(
    options.checkedAt ??
      values.SSO_SMOKE_CHECKED_AT ??
      new Date().toISOString(),
  );
  const issuerUrl = readIssuerUrl(values, options);
  const checks = buildChecks(values);
  const failed = checks.filter((check) => check.passed !== true);

  if (!checkedAt) {
    throw new Error("SSO_SMOKE_CHECKED_AT must be a valid date-time when set");
  }
  if (failed.length > 0 && !allowFailed) {
    throw new Error(
      `SSO smoke evidence is incomplete; failed checks: ${failed.map((check) => check.name).join(", ")}`,
    );
  }

  const ssoSmoke = {
    issuerUrl,
    checkedAt,
    oidcLoginSucceeded: checkValue(checks, "oidcLoginSucceeded"),
    humanIdentitySmokePassed: checkValue(checks, "humanIdentitySmokePassed"),
    agentIdentitySmokePassed: checkValue(checks, "agentIdentitySmokePassed"),
    serviceIdentitySmokePassed: checkValue(
      checks,
      "serviceIdentitySmokePassed",
    ),
    publicRegistrationLocked: checkValue(checks, "publicRegistrationLocked"),
    nonIssuerRejected: checkValue(checks, "nonIssuerRejected"),
    recoveryAdminLoginSucceeded: checkValue(
      checks,
      "recoveryAdminLoginSucceeded",
    ),
    checks,
  };

  for (const [field, envKey] of OPTIONAL_CONTEXT_FIELDS) {
    const value = cleanValue(values[envKey]);
    if (value !== null) ssoSmoke[field] = value;
  }

  const evidence = {
    schema: "https://eliza.hub/schemas/sso-smoke-evidence.v1",
    ssoSmoke,
  };

  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ ssoSmokeEvidence: { source: output, checkedAt, failedChecks: failed.map((check) => check.name) } }, null, 2)}\n`,
  );
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--allow-env-only") {
      options.allowEnvOnly = true;
      continue;
    }
    if (arg === "--allow-failed") {
      options.allowFailed = true;
      continue;
    }
    if (arg === "--env-file") {
      index += 1;
      options.envFile = requireArg(args[index], "--env-file");
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      options.envFile = requireArg(
        arg.slice("--env-file=".length),
        "--env-file",
      );
      continue;
    }
    if (arg === "--output") {
      index += 1;
      options.output = requireArg(args[index], "--output");
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.output = requireArg(arg.slice("--output=".length), "--output");
      continue;
    }
    if (arg === "--checked-at") {
      index += 1;
      options.checkedAt = requireArg(args[index], "--checked-at");
      continue;
    }
    if (arg.startsWith("--checked-at=")) {
      options.checkedAt = requireArg(
        arg.slice("--checked-at=".length),
        "--checked-at",
      );
      continue;
    }
    if (arg === "--issuer-url") {
      index += 1;
      options.issuerUrl = requireArg(args[index], "--issuer-url");
      continue;
    }
    if (arg.startsWith("--issuer-url=")) {
      options.issuerUrl = requireArg(
        arg.slice("--issuer-url=".length),
        "--issuer-url",
      );
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function buildChecks(values) {
  return REQUIRED_SMOKE_CHECKS.map((definition) => {
    const parsed = readBoolean(values, definition);
    if (parsed === undefined) {
      throw new Error(`${definition.envKey} must be true or false when set`);
    }

    return {
      name: definition.key,
      passed: parsed === true,
      evidence: evidenceLabel(values, definition),
    };
  });
}

function readBoolean(values, definition) {
  for (const key of [definition.envKey, ...definition.aliases]) {
    const value = parseBoolean(values[key], null);
    if (value !== null) return value;
  }
  return false;
}

function evidenceLabel(values, definition) {
  for (const key of [definition.envKey, ...definition.aliases]) {
    if (cleanValue(values[key]) !== null) return key;
  }
  return "missing";
}

function checkValue(checks, name) {
  return checks.find((check) => check.name === name)?.passed === true;
}

function readIssuerUrl(values, options) {
  const issuerUrl = cleanValue(
    options.issuerUrl ??
      values.SSO_SMOKE_ISSUER_URL ??
      values.SSO_EVIDENCE_ISSUER_URL ??
      values.ELIZA_CLOUD_OIDC_ISSUER_URL,
  );
  if (issuerUrl === null)
    throw new Error(
      "SSO_SMOKE_ISSUER_URL or ELIZA_CLOUD_OIDC_ISSUER_URL is required",
    );

  try {
    const url = new URL(issuerUrl);
    if (url.protocol !== "https:") throw new Error("issuer must use https");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("SSO smoke issuer URL must be a valid https URL");
  }
}

function readConfiguration(envFile, processEnv, { allowEnvOnly = false } = {}) {
  const values = { ...processEnv };
  if (!existsSync(envFile)) {
    if (allowEnvOnly || parseBoolean(processEnv.ALLOW_ENV_ONLY, false) === true)
      return values;
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  const lines = readFileSync(envFile, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (/^(?:export|source|\.)\s/.test(trimmed)) {
      throw new Error(
        `unsupported shell syntax in ${envFile} line ${index + 1}`,
      );
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match)
      throw new Error(
        `malformed env assignment in ${envFile} line ${index + 1}`,
      );
    if (match[2].includes("$(") || match[2].includes("`")) {
      throw new Error(
        `command substitution is not allowed in ${envFile} line ${index + 1}`,
      );
    }

    values[match[1]] = unquote(match[2]);
  });

  return values;
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function normalizeIso(value) {
  const normalized = cleanValue(value);
  if (normalized === null) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseBoolean(value, fallback = null) {
  const normalized = cleanValue(value);
  if (normalized === null) return fallback;
  if (TRUE_PATTERN.test(normalized)) return true;
  if (FALSE_PATTERN.test(normalized)) return false;
  return undefined;
}

function cleanValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function requireArg(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function usage() {
  return `Usage: sso-smoke-evidence.mjs [--env-file PATH] [--output PATH] [--allow-failed]

Writes structured SSO smoke evidence JSON for sso-evidence.mjs and the
production gate. The output is private operator evidence and is not committed.

Required:
  SSO_SMOKE_ISSUER_URL or ELIZA_CLOUD_OIDC_ISSUER_URL
  SSO_SMOKE_OIDC_LOGIN_SUCCEEDED=true
  SSO_SMOKE_HUMAN_IDENTITY_SMOKE_PASSED=true
  SSO_SMOKE_AGENT_IDENTITY_SMOKE_PASSED=true
  SSO_SMOKE_SERVICE_IDENTITY_SMOKE_PASSED=true
  SSO_SMOKE_PUBLIC_REGISTRATION_LOCKED=true
  SSO_SMOKE_NON_ISSUER_REJECTED=true
  SSO_SMOKE_RECOVERY_ADMIN_LOGIN_SUCCEEDED=true

Optional:
  SSO_SMOKE_OUTPUT
  SSO_SMOKE_CHECKED_AT
  SSO_SMOKE_HUMAN_SUBJECT
  SSO_SMOKE_AGENT_SUBJECT
  SSO_SMOKE_SERVICE_SUBJECT
  SSO_SMOKE_NOTES

Use --allow-failed only to retain failed private smoke output for debugging;
production cutover evidence requires all checks to pass.
`;
}

main().catch((error) => {
  process.stderr.write(
    `[sso-smoke-evidence] error: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exit(1);
});
