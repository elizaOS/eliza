#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const LIST_FIELDS = Object.freeze([
  {
    outputKey: "protectedBranches",
    envKey: "REPOSITORY_EVIDENCE_PROTECTED_BRANCHES",
    fallbackKey: "FORGEJO_PROTECTED_BRANCHES",
  },
  {
    outputKey: "requiredChecks",
    envKey: "REPOSITORY_EVIDENCE_REQUIRED_CHECKS",
    fallbackKey: "FORGEJO_REQUIRED_CHECKS",
  },
]);

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "forkPolicyReviewed",
    envKey: "REPOSITORY_EVIDENCE_FORK_POLICY_REVIEWED",
  },
  {
    outputKey: "actionsPolicyReviewed",
    envKey: "REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED",
  },
  {
    outputKey: "adminBypassReviewed",
    envKey: "REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED",
  },
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_REPOSITORY_PROTECTION_OUTPUT = artifactPath(
  "repository-protection.json",
);

main().catch((error) => {
  console.error(`[repository-evidence] error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
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
  const repository = {};
  const requireLive = readRequireLive(options, values, errors);
  const repositoryProtectionResult = await readRepositoryProtectionAudit({
    options,
    values,
    requireLive,
    errors,
  });
  const repositoryProtection = repositoryProtectionResult?.audit ?? null;

  if (repositoryProtection) {
    validateRepositoryProtectionAudit(repositoryProtection, errors);
  }

  for (const field of LIST_FIELDS) {
    repository[field.outputKey] =
      listFromRepositoryProtection(repositoryProtection, field.outputKey) ??
      parseList(values[field.envKey] ?? values[field.fallbackKey]);
  }

  for (const field of BOOLEAN_FIELDS) {
    const parsed = readBooleanAttestation(values, field.envKey, errors);
    const inferred =
      field.outputKey === "forkPolicyReviewed"
        ? inferForkPolicyReviewed(repositoryProtection)
        : null;
    repository[field.outputKey] = parsed ?? inferred ?? false;
  }
  repository.liveProtectionEvidence = repositoryProtection
    ? liveProtectionEvidence(
        repositoryProtection,
        repositoryProtectionResult.source,
        repositoryProtectionResult.sha256,
      )
    : null;

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[repository-evidence] error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ repository }, null, 2)}\n`);
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

    if (arg === "--repository-protection-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--repository-protection-json requires a path");
      }
      options.repositoryProtectionJson = args[index];
      continue;
    }

    if (arg.startsWith("--repository-protection-json=")) {
      options.repositoryProtectionJson = arg.slice(
        "--repository-protection-json=".length,
      );
      if (!options.repositoryProtectionJson) {
        throw new Error("--repository-protection-json requires a path");
      }
      continue;
    }

    if (arg === "--repository-protection-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--repository-protection-output requires a path");
      }
      options.repositoryProtectionOutput = args[index];
      continue;
    }

    if (arg.startsWith("--repository-protection-output=")) {
      options.repositoryProtectionOutput = arg.slice(
        "--repository-protection-output=".length,
      );
      if (!options.repositoryProtectionOutput) {
        throw new Error("--repository-protection-output requires a path");
      }
      continue;
    }

    if (arg === "--steward-url") {
      index += 1;
      if (!args[index]) {
        throw new Error("--steward-url requires a URL");
      }
      options.stewardUrl = args[index];
      continue;
    }

    if (arg.startsWith("--steward-url=")) {
      options.stewardUrl = arg.slice("--steward-url=".length);
      if (!options.stewardUrl) {
        throw new Error("--steward-url requires a URL");
      }
      continue;
    }

    if (arg === "--repo") {
      index += 1;
      if (!args[index]) {
        throw new Error("--repo requires owner/name");
      }
      options.repo = args[index];
      continue;
    }

    if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
      if (!options.repo) {
        throw new Error("--repo requires owner/name");
      }
      continue;
    }

    if (arg === "--target-branch") {
      index += 1;
      if (!args[index]) {
        throw new Error("--target-branch requires a branch");
      }
      options.targetBranch = args[index];
      continue;
    }

    if (arg.startsWith("--target-branch=")) {
      options.targetBranch = arg.slice("--target-branch=".length);
      if (!options.targetBranch) {
        throw new Error("--target-branch requires a branch");
      }
      continue;
    }

    if (arg === "--require-live") {
      options.requireLive = true;
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
    ...LIST_FIELDS.flatMap((field) => [field.envKey, field.fallbackKey]),
    ...BOOLEAN_FIELDS.map((field) => field.envKey),
    "REPOSITORY_EVIDENCE_REQUIRE_LIVE",
    "REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_JSON",
    "REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_OUTPUT",
    "REPOSITORY_EVIDENCE_STEWARD_URL",
    "REPOSITORY_EVIDENCE_REPO",
    "REPOSITORY_EVIDENCE_TARGET_BRANCH",
    "REPOSITORY_EVIDENCE_STEWARD_TOKEN",
    "MERGE_STEWARD_URL",
    "MERGE_STEWARD_SMOKE_REPO",
    "MERGE_STEWARD_DOCTOR_TOKEN",
    "MERGE_STEWARD_API_TOKEN",
  ];
}

function readRequireLive(options, values, errors) {
  if (options.requireLive === true) {
    return true;
  }

  const parsed = parseBoolean(values.REPOSITORY_EVIDENCE_REQUIRE_LIVE);
  if (parsed === undefined) {
    errors.push(
      "REPOSITORY_EVIDENCE_REQUIRE_LIVE must be true or false when set",
    );
    return false;
  }

  return parsed ?? false;
}

async function readRepositoryProtectionAudit({
  options,
  values,
  requireLive,
  errors,
}) {
  const auditPath =
    options.repositoryProtectionJson ??
    values.REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_JSON;
  if (auditPath) {
    return {
      audit: readRepositoryProtectionJson(auditPath),
      source: auditPath,
      sha256: sha256File(auditPath),
    };
  }

  const stewardUrl =
    options.stewardUrl ??
    values.REPOSITORY_EVIDENCE_STEWARD_URL ??
    (requireLive ? values.MERGE_STEWARD_URL : null);
  if (stewardUrl) {
    const repo =
      options.repo ??
      values.REPOSITORY_EVIDENCE_REPO ??
      values.MERGE_STEWARD_SMOKE_REPO;
    const audit = await fetchRepositoryProtectionAudit({
      stewardUrl,
      repo,
      targetBranch:
        options.targetBranch ?? values.REPOSITORY_EVIDENCE_TARGET_BRANCH,
      token:
        values.REPOSITORY_EVIDENCE_STEWARD_TOKEN ??
        values.MERGE_STEWARD_DOCTOR_TOKEN ??
        values.MERGE_STEWARD_API_TOKEN,
    });
    const outputPath =
      options.repositoryProtectionOutput ??
      values.REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_OUTPUT ??
      DEFAULT_REPOSITORY_PROTECTION_OUTPUT;
    writeRepositoryProtectionArtifact(outputPath, audit);
    return {
      audit,
      source: outputPath,
      sha256: sha256File(outputPath),
    };
  }

  if (requireLive) {
    errors.push(
      "live repository protection evidence is required; set REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_JSON or --steward-url",
    );
  }

  return null;
}

function readRepositoryProtectionJson(auditPath) {
  if (!existsSync(auditPath)) {
    throw new Error(`repository protection JSON does not exist: ${auditPath}`);
  }

  return extractRepositoryProtection(
    JSON.parse(readFileSync(auditPath, "utf8")),
  );
}

function writeRepositoryProtectionArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ repositoryProtection: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function fetchRepositoryProtectionAudit({
  stewardUrl,
  repo,
  targetBranch,
  token,
}) {
  if (!repo) {
    throw new Error(
      "--repo or REPOSITORY_EVIDENCE_REPO is required when --steward-url is used",
    );
  }

  const url = stewardApiUrl(stewardUrl, "/api/repository-protection");
  url.searchParams.set("repo", repo);
  url.searchParams.set("requireLive", "true");
  if (targetBranch) {
    url.searchParams.set("targetBranch", targetBranch);
  }

  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `repository protection request failed with HTTP ${response.status}`,
    );
  }

  return extractRepositoryProtection(await response.json());
}

function stewardApiUrl(baseUrl, route) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${route}`;
  url.search = "";
  url.hash = "";
  return url;
}

function extractRepositoryProtection(payload) {
  const audit =
    payload?.repositoryProtection ??
    payload?.repositoryProtectionAudit ??
    payload?.audit ??
    payload;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    throw new Error(
      "repository protection JSON does not contain a repositoryProtection object",
    );
  }
  return audit;
}

function validateRepositoryProtectionAudit(audit, errors) {
  if (audit.productionReady !== true || audit.status !== "protected") {
    errors.push(
      "repository protection audit must be production-ready before generating repository evidence",
    );
  }

  if (audit.live?.available !== true || audit.live?.required !== true) {
    errors.push(
      "repository protection audit must include required live Forgejo verification",
    );
  }

  if (listFromRepositoryProtection(audit, "protectedBranches")?.length === 0) {
    errors.push(
      "repository protection audit is missing protected branch policy",
    );
  }

  if (listFromRepositoryProtection(audit, "requiredChecks")?.length === 0) {
    errors.push("repository protection audit is missing required check policy");
  }
}

function listFromRepositoryProtection(audit, outputKey) {
  if (!audit) {
    return null;
  }

  const key =
    outputKey === "protectedBranches" ? "protectedBranches" : "requiredChecks";
  return parseList(audit.policy?.[key]);
}

function inferForkPolicyReviewed(audit) {
  if (!audit) {
    return null;
  }

  const check = Array.isArray(audit.checks)
    ? audit.checks.find((item) => item?.name === "fork_policy_reviewed")
    : null;
  return check?.status === "pass" ? true : null;
}

function liveProtectionEvidence(audit, source, sha256) {
  return {
    source,
    sha256,
    checkedAt:
      normalizeIso(audit.computedAt ?? audit.checkedAt) ??
      new Date().toISOString(),
    status: audit.status ?? null,
    productionReady: audit.productionReady === true,
    liveAvailable: audit.live?.available === true,
    liveRequired: audit.live?.required === true,
    checkCount: Array.isArray(audit.checks) ? audit.checks.length : 0,
  };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizeIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
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

function parseList(value) {
  const normalized = cleanValue(value);

  if (normalized === null) {
    return [];
  }

  return [
    ...new Set(
      normalized
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
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

function usage() {
  return `Usage: repository-evidence.mjs [--env-file PATH]
                               [--repository-protection-json PATH]
                               [--repository-protection-output PATH]
                               [--steward-url URL --repo owner/name [--target-branch BRANCH]]
                               [--require-live]

Prints a production evidence repository block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Protected branches and required checks are inferred from:
  FORGEJO_PROTECTED_BRANCHES
  FORGEJO_REQUIRED_CHECKS

They can also be overridden explicitly:
  REPOSITORY_EVIDENCE_PROTECTED_BRANCHES
  REPOSITORY_EVIDENCE_REQUIRED_CHECKS

Review attestations default to false unless set:
  REPOSITORY_EVIDENCE_FORK_POLICY_REVIEWED
  REPOSITORY_EVIDENCE_ACTIONS_POLICY_REVIEWED
  REPOSITORY_EVIDENCE_ADMIN_BYPASS_REVIEWED

For production cutover, pass --require-live with either:
  --repository-protection-json $ELIZA_ARTIFACT_ROOT/repository-protection.json
  --steward-url "$MERGE_STEWARD_URL" --repo elizaos/eliza
  --repository-protection-output $ELIZA_ARTIFACT_ROOT/repository-protection.json

When --steward-url is used, the fetched live audit is written to
REPOSITORY_EVIDENCE_REPOSITORY_PROTECTION_OUTPUT or --repository-protection-output
so production validation can re-read the local artifact and verify its SHA-256.

Live repository protection evidence must be production-ready and include
requireLive=true Forgejo verification before this helper emits evidence.
`;
}
