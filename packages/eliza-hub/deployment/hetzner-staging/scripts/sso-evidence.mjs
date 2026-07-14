#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SSO_FIELDS = Object.freeze([
  {
    outputKey: "oidcProviderStaged",
    envKey: "SSO_EVIDENCE_OIDC_PROVIDER_STAGED",
  },
  {
    outputKey: "forgejoOidcSourceConfigured",
    envKey: "SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED",
  },
  {
    outputKey: "smokeTested",
    envKey: "SSO_EVIDENCE_SMOKE_TESTED",
  },
  {
    outputKey: "humanIdentitySmokePassed",
    envKey: "SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED",
  },
  {
    outputKey: "agentIdentitySmokePassed",
    envKey: "SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED",
  },
  {
    outputKey: "serviceIdentitySmokePassed",
    envKey: "SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED",
  },
  {
    outputKey: "publicRegistrationLocked",
    envKey: "SSO_EVIDENCE_PUBLIC_REGISTRATION_LOCKED",
  },
  {
    outputKey: "autoCreateRestrictedToIssuer",
    envKey: "SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER",
  },
  {
    outputKey: "recoveryAdminVerified",
    envKey: "SSO_EVIDENCE_RECOVERY_ADMIN_VERIFIED",
  },
]);

const CONFIG_KEYS = Object.freeze([
  "SSO_EVIDENCE_ISSUER_URL",
  "ELIZA_CLOUD_OIDC_ISSUER_URL",
  "ELIZA_CLOUD_OIDC_DISCOVERY_URL",
  "ELIZA_CLOUD_FORGEJO_CLIENT_ID",
  "ELIZA_CLOUD_FORGEJO_CLIENT_SECRET",
  "FORGEJO_OIDC_AUTH_NAME",
  "FORGEJO_OIDC_SCOPES",
  "FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION",
  "FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM",
  "FORGEJO_OAUTH2_USERNAME",
  "FORGEJO_OAUTH2_ACCOUNT_LINKING",
  "FORGEJO_OIDC_REQUIRED_CLAIM_NAME",
  "FORGEJO_OIDC_REQUIRED_CLAIM_VALUE",
  "FORGEJO_OIDC_GROUP_CLAIM_NAME",
  "FORGEJO_OIDC_ADMIN_GROUP",
  "FORGEJO_OIDC_RESTRICTED_GROUP",
  "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON",
]);

const REQUIRED_SCOPES = Object.freeze(["openid", "email", "profile", "groups"]);
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
    const deployDir = path.resolve(scriptDir, "..");
    const defaultEnvFile = path.resolve(deployDir, ".env");
    const defaultComposeFile = path.resolve(deployDir, "compose.yml");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const composeFile =
      options.composeFile ?? process.env.COMPOSE_FILE ?? defaultComposeFile;
    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const issuerUrl = readIssuerUrl(values, errors);
    const smokeEvidence = readSmokeEvidence(
      options.smokeJson ?? values.SSO_EVIDENCE_SMOKE_JSON,
      issuerUrl,
      errors,
    );
    const bootstrapEvidence = readBootstrapEvidence(
      options.identityBootstrapJson ??
        values.SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON,
      issuerUrl,
      errors,
    );
    const providerConfigComplete = oidcProviderConfigComplete(values);
    const sourceConfigComplete =
      providerConfigComplete && forgejoOidcSourceConfigComplete(values);
    const publicRegistrationLocked = inferPublicRegistrationLocked(
      values,
      composeFile,
    );
    const sso = { issuerUrl };

    for (const field of SSO_FIELDS) {
      const attested = readBooleanAttestation(values, field.envKey, errors);
      sso[field.outputKey] =
        attested ??
        inferredFieldValue(field.outputKey, {
          providerConfigComplete,
          sourceConfigComplete,
          publicRegistrationLocked,
          smokeEvidence,
        });
    }
    sso.smokeEvidence = smokeEvidence
      ? {
          source: smokeEvidence.source,
          sha256: smokeEvidence.sha256,
          checkedAt: smokeEvidence.checkedAt,
        }
      : null;
    sso.bootstrapEvidence = bootstrapEvidence
      ? {
          source: bootstrapEvidence.source,
          sha256: bootstrapEvidence.sha256,
          checkedAt: bootstrapEvidence.checkedAt,
          status: bootstrapEvidence.status,
          checkCount: bootstrapEvidence.checkCount,
        }
      : null;

    validatePositiveAttestations(
      sso,
      { providerConfigComplete, sourceConfigComplete, bootstrapEvidence },
      errors,
    );

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[sso-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write(`${JSON.stringify({ sso }, null, 2)}\n`);
  } catch (error) {
    console.error(`[sso-evidence] error: ${error.message}`);
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

    if (arg === "--smoke-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--smoke-json requires a path");
      }
      options.smokeJson = args[index];
      continue;
    }

    if (arg.startsWith("--smoke-json=")) {
      options.smokeJson = arg.slice("--smoke-json=".length);
      if (!options.smokeJson) {
        throw new Error("--smoke-json requires a path");
      }
      continue;
    }

    if (arg === "--identity-bootstrap-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--identity-bootstrap-json requires a path");
      }
      options.identityBootstrapJson = args[index];
      continue;
    }

    if (arg.startsWith("--identity-bootstrap-json=")) {
      options.identityBootstrapJson = arg.slice(
        "--identity-bootstrap-json=".length,
      );
      if (!options.identityBootstrapJson) {
        throw new Error("--identity-bootstrap-json requires a path");
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
    "SSO_EVIDENCE_SMOKE_JSON",
    ...SSO_FIELDS.map((field) => field.envKey),
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

function readIssuerUrl(values, errors) {
  const issuerUrl = cleanValue(
    values.SSO_EVIDENCE_ISSUER_URL ?? values.ELIZA_CLOUD_OIDC_ISSUER_URL,
  );

  if (issuerUrl === null) {
    errors.push(
      "SSO_EVIDENCE_ISSUER_URL or ELIZA_CLOUD_OIDC_ISSUER_URL is required",
    );
    return "";
  }

  if (!isPrivateHttpsUrl(issuerUrl)) {
    errors.push(
      "SSO_EVIDENCE_ISSUER_URL or ELIZA_CLOUD_OIDC_ISSUER_URL must be a non-placeholder https:// URL",
    );
  }

  return issuerUrl;
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

function inferredFieldValue(outputKey, inferred) {
  switch (outputKey) {
    case "oidcProviderStaged":
      return inferred.providerConfigComplete;
    case "forgejoOidcSourceConfigured":
      return inferred.sourceConfigComplete;
    case "smokeTested":
      return inferred.smokeEvidence?.smokeTested === true;
    case "humanIdentitySmokePassed":
      return inferred.smokeEvidence?.humanIdentitySmokePassed === true;
    case "agentIdentitySmokePassed":
      return inferred.smokeEvidence?.agentIdentitySmokePassed === true;
    case "serviceIdentitySmokePassed":
      return inferred.smokeEvidence?.serviceIdentitySmokePassed === true;
    case "publicRegistrationLocked":
      return (
        inferred.smokeEvidence?.publicRegistrationLocked === true ||
        inferred.publicRegistrationLocked
      );
    case "autoCreateRestrictedToIssuer":
      return inferred.smokeEvidence?.autoCreateRestrictedToIssuer === true;
    case "recoveryAdminVerified":
      return inferred.smokeEvidence?.recoveryAdminVerified === true;
    default:
      return false;
  }
}

function readSmokeEvidence(smokeJson, issuerUrl, errors) {
  const cleanPath = cleanValue(smokeJson);
  if (cleanPath === null) {
    return null;
  }

  let body;
  let rawBody;
  try {
    rawBody = readFileSync(cleanPath, "utf8");
    body = JSON.parse(rawBody);
  } catch (error) {
    errors.push(`SSO_EVIDENCE_SMOKE_JSON could not be read: ${error.message}`);
    return null;
  }

  if (!isRecord(body)) {
    errors.push("SSO_EVIDENCE_SMOKE_JSON must contain a JSON object");
    return null;
  }

  const smoke = body.ssoSmoke ?? body.sso ?? body;
  if (!isRecord(smoke)) {
    errors.push("SSO_EVIDENCE_SMOKE_JSON ssoSmoke must be a JSON object");
    return null;
  }

  const smokeIssuer = cleanValue(
    smoke.issuerUrl ?? smoke.issuer ?? smoke.elizaCloudIssuerUrl,
  );
  if (smokeIssuer && issuerUrl && smokeIssuer !== issuerUrl) {
    errors.push(
      "SSO_EVIDENCE_SMOKE_JSON issuerUrl does not match configured issuer",
    );
  }
  const checkedAt = normalizeIso(
    smoke.checkedAt ??
      smoke.completedAt ??
      smoke.smokeTestedAt ??
      body.checkedAt,
  );
  if (!checkedAt) {
    errors.push(
      "SSO_EVIDENCE_SMOKE_JSON must include a valid checkedAt timestamp",
    );
  }

  const smokeTested = readSmokeBoolean(smoke, [
    "smokeTested",
    "oidcLoginSucceeded",
    "loginSucceeded",
    "browserSignInPassed",
  ]);
  const humanIdentitySmokePassed = readSmokeBoolean(smoke, [
    "humanIdentitySmokePassed",
    "humanLoginSucceeded",
    "humanClaimsVerified",
    "humanAccountLinked",
  ]);
  const agentIdentitySmokePassed = readSmokeBoolean(smoke, [
    "agentIdentitySmokePassed",
    "agentTokenClaimsVerified",
    "agentClaimsVerified",
    "agentEndpointBindingPassed",
    "agentClaimMutationBound",
  ]);
  const serviceIdentitySmokePassed = readSmokeBoolean(smoke, [
    "serviceIdentitySmokePassed",
    "serviceTokenClaimsVerified",
    "serviceClaimsVerified",
    "serviceAccountSmokePassed",
  ]);
  const publicRegistrationLocked = readSmokeBoolean(smoke, [
    "publicRegistrationLocked",
    "registrationLocked",
  ]);
  const autoCreateRestrictedToIssuer = readSmokeBoolean(smoke, [
    "autoCreateRestrictedToIssuer",
    "issuerRestricted",
    "nonIssuerRejected",
  ]);
  const recoveryAdminVerified = readSmokeBoolean(smoke, [
    "recoveryAdminVerified",
    "recoveryAdminLoginSucceeded",
  ]);

  return {
    source: cleanPath,
    sha256: sha256String(rawBody),
    checkedAt,
    smokeTested,
    humanIdentitySmokePassed,
    agentIdentitySmokePassed,
    serviceIdentitySmokePassed,
    publicRegistrationLocked,
    autoCreateRestrictedToIssuer,
    recoveryAdminVerified,
  };
}

function readBootstrapEvidence(bootstrapJson, issuerUrl, errors) {
  const cleanPath = cleanValue(bootstrapJson);
  if (cleanPath === null) {
    return null;
  }

  let body;
  let rawBody;
  try {
    rawBody = readFileSync(cleanPath, "utf8");
    body = JSON.parse(rawBody);
  } catch (error) {
    errors.push(
      `SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON could not be read: ${error.message}`,
    );
    return null;
  }

  if (!isRecord(body)) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must contain a JSON object",
    );
    return null;
  }

  const checkedAt = normalizeIso(body.finishedAt ?? body.checkedAt);
  if (!checkedAt) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must include a valid finishedAt timestamp",
    );
  }
  if (
    body.schema !== "https://eliza.hub/schemas/identity-bootstrap-evidence.v1"
  ) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must use identity-bootstrap-evidence.v1",
    );
  }
  if (body.status !== "passed") {
    errors.push("SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must have status=passed");
  }
  if (body.summary?.failed !== 0) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must have zero failed checks",
    );
  }
  if (body.options?.applyBootstrap !== false) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must be captured from read-only APPLY_BOOTSTRAP=false verification",
    );
  }
  if (body.oidc?.issuerUrl && issuerUrl && body.oidc.issuerUrl !== issuerUrl) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON issuerUrl does not match configured issuer",
    );
  }

  const checks = Array.isArray(body.checks) ? body.checks : [];
  if (checks.length === 0) {
    errors.push(
      "SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON must include identity bootstrap checks",
    );
  }

  return {
    source: cleanPath,
    sha256: sha256String(rawBody),
    checkedAt,
    status: body.status ?? null,
    checkCount: checks.length,
  };
}

function readSmokeBoolean(smoke, keys) {
  return keys.some((key) => smoke?.[key] === true);
}

function sha256String(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeIso(value) {
  const normalized = cleanValue(value);
  if (normalized === null) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function oidcProviderConfigComplete(values) {
  return (
    isPrivateHttpsUrl(values.ELIZA_CLOUD_OIDC_ISSUER_URL) &&
    isPrivateHttpsUrl(values.ELIZA_CLOUD_OIDC_DISCOVERY_URL) &&
    isPresent(values.ELIZA_CLOUD_FORGEJO_CLIENT_ID) &&
    isIssuedSecret(values.ELIZA_CLOUD_FORGEJO_CLIENT_SECRET, 24)
  );
}

function forgejoOidcSourceConfigComplete(values) {
  return (
    isPresent(values.FORGEJO_OIDC_AUTH_NAME) &&
    hasRequiredScopes(values.FORGEJO_OIDC_SCOPES) &&
    parseBoolean(values.FORGEJO_OAUTH2_ENABLE_AUTO_REGISTRATION) === true &&
    parseBoolean(values.FORGEJO_OAUTH2_REGISTER_EMAIL_CONFIRM) === false &&
    ["userid", "nickname", "email"].includes(
      cleanValue(values.FORGEJO_OAUTH2_USERNAME),
    ) &&
    ["disabled", "login"].includes(
      cleanValue(values.FORGEJO_OAUTH2_ACCOUNT_LINKING),
    ) &&
    isPresent(values.FORGEJO_OIDC_REQUIRED_CLAIM_NAME) &&
    isPresent(values.FORGEJO_OIDC_REQUIRED_CLAIM_VALUE) &&
    isPresent(values.FORGEJO_OIDC_GROUP_CLAIM_NAME) &&
    isPresent(values.FORGEJO_OIDC_ADMIN_GROUP) &&
    isPresent(values.FORGEJO_OIDC_RESTRICTED_GROUP)
  );
}

function inferPublicRegistrationLocked(values, composeFile) {
  const attested = parseBoolean(values.SSO_EVIDENCE_PUBLIC_REGISTRATION_LOCKED);
  if (attested !== null && attested !== undefined) {
    return attested;
  }

  if (!existsSync(composeFile)) {
    return false;
  }

  const compose = readFileSync(composeFile, "utf8");
  return (
    composeEnvTrue(compose, "FORGEJO__service__DISABLE_REGISTRATION") &&
    composeEnvTrue(
      compose,
      "FORGEJO__service__ALLOW_ONLY_EXTERNAL_REGISTRATION",
    ) &&
    composeEnvTrue(compose, "FORGEJO__service__REQUIRE_SIGNIN_VIEW")
  );
}

function validatePositiveAttestations(sso, inferred, errors) {
  if (sso.oidcProviderStaged && !inferred.providerConfigComplete) {
    errors.push(
      "SSO_EVIDENCE_OIDC_PROVIDER_STAGED cannot be true until OIDC issuer, discovery, client id, and client secret are configured",
    );
  }

  if (sso.forgejoOidcSourceConfigured && !inferred.sourceConfigComplete) {
    errors.push(
      "SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED cannot be true until Forgejo OIDC auth name, scopes, and Eliza Cloud client config are complete",
    );
  }

  if (sso.forgejoOidcSourceConfigured && !inferred.bootstrapEvidence) {
    errors.push(
      "SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED cannot be true without SSO_EVIDENCE_IDENTITY_BOOTSTRAP_JSON from bootstrap-forgejo-identity.sh",
    );
  }

  if (sso.smokeTested && !inferred.sourceConfigComplete) {
    errors.push(
      "SSO_EVIDENCE_SMOKE_TESTED cannot be true until the Forgejo OIDC source config is complete",
    );
  }

  for (const [field, envKey] of [
    ["humanIdentitySmokePassed", "SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED"],
    ["agentIdentitySmokePassed", "SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED"],
    [
      "serviceIdentitySmokePassed",
      "SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED",
    ],
  ]) {
    if (sso[field] && !inferred.sourceConfigComplete) {
      errors.push(
        `${envKey} cannot be true until the Forgejo OIDC source config is complete`,
      );
    }
    if (sso[field] && !sso.smokeTested) {
      errors.push(
        `${envKey} cannot be true until SSO_EVIDENCE_SMOKE_TESTED is true`,
      );
    }
  }

  if (sso.autoCreateRestrictedToIssuer && !inferred.sourceConfigComplete) {
    errors.push(
      "SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER cannot be true until the Forgejo OIDC source config is complete",
    );
  }

  if (sso.autoCreateRestrictedToIssuer && !sso.publicRegistrationLocked) {
    errors.push(
      "SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER cannot be true until public Forgejo registration is locked",
    );
  }
}

function composeEnvTrue(compose, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `${escapedKey}\\s*:\\s*(?:"true"|'true'|true)(?:\\s|$)`,
    "u",
  );
  return pattern.test(compose);
}

function hasRequiredScopes(value) {
  const normalized = cleanValue(value);

  if (normalized === null || hasBadPlaceholder(normalized)) {
    return false;
  }

  const scopes = new Set(normalized.split(/[,\s]+/u).filter(Boolean));
  return REQUIRED_SCOPES.every((scope) => scopes.has(scope));
}

function isPrivateHttpsUrl(value) {
  const normalized = cleanValue(value);

  if (normalized === null || hasBadPlaceholder(normalized)) {
    return false;
  }

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
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
  return `Usage: sso-evidence.mjs [--env-file PATH] [--compose-file PATH] [--smoke-json PATH] [--identity-bootstrap-json PATH]

Prints a production evidence SSO block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. No OIDC client
secret, recovery-admin credential, or unrelated secret value is printed.

issuerUrl is read from:
  SSO_EVIDENCE_ISSUER_URL
  ELIZA_CLOUD_OIDC_ISSUER_URL

oidcProviderStaged is inferred from non-placeholder Eliza Cloud OIDC issuer,
discovery, client id, and client secret values, or can be attested explicitly:
  SSO_EVIDENCE_OIDC_PROVIDER_STAGED

forgejoOidcSourceConfigured is inferred from the Eliza Cloud client config plus
Forgejo OIDC auth name and openid/email/profile/groups scopes, or can be
attested explicitly:
  SSO_EVIDENCE_FORGEJO_OIDC_SOURCE_CONFIGURED

publicRegistrationLocked is inferred from compose.yml when Forgejo disables
public registration, allows only external registration, and requires sign-in
view, or can be attested explicitly:
  SSO_EVIDENCE_PUBLIC_REGISTRATION_LOCKED

Live launch checks can be inferred from a private structured smoke JSON file:
  --smoke-json PATH
  SSO_EVIDENCE_SMOKE_JSON

The smoke JSON may contain ssoSmoke, sso, or root fields:
  issuerUrl
  checkedAt
  oidcLoginSucceeded
  humanIdentitySmokePassed
  agentIdentitySmokePassed
  serviceIdentitySmokePassed
  publicRegistrationLocked
  nonIssuerRejected
  recoveryAdminLoginSucceeded

Live launch checks default to false unless set after verification:
  SSO_EVIDENCE_SMOKE_TESTED
  SSO_EVIDENCE_HUMAN_IDENTITY_SMOKE_PASSED
  SSO_EVIDENCE_AGENT_IDENTITY_SMOKE_PASSED
  SSO_EVIDENCE_SERVICE_IDENTITY_SMOKE_PASSED
  SSO_EVIDENCE_AUTO_CREATE_RESTRICTED_TO_ISSUER
  SSO_EVIDENCE_RECOVERY_ADMIN_VERIFIED
`;
}
