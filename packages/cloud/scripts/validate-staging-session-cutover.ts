/**
 * Value-safe preflight for the default-off staging QA session cutover.
 * Returns field names/reasons only; credential and allowlist values are never
 * included in diagnostics.
 */

import { fileURLToPath } from "node:url";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_RE = /^staging-qa-v1-[A-Za-z0-9._-]{1,48}$/;
const EXPECTED_VERSION = "v1";

function exactUuidList(value) {
  const entries = value
    ?.split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.length <= 100 &&
    entries.every((entry) => UUID_RE.test(entry))
  );
}

export function validateStagingSessionCutoverConfig(env) {
  if (
    env.DEPLOY_ENVIRONMENT !== "staging" ||
    env.STAGING_SESSION_EXCHANGE_DESIRED_ENABLED !== "true"
  ) {
    return [];
  }

  const errors = [];
  if (env.STAGING_SESSION_EXCHANGE_VERSION?.trim() !== EXPECTED_VERSION) {
    errors.push("STAGING_SESSION_EXCHANGE_VERSION must be v1");
  }
  if (
    !KEY_ID_RE.test(env.STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?.trim() ?? "")
  ) {
    errors.push("STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID is invalid");
  }
  if ((env.STAGING_SESSION_EXCHANGE_SIGNING_SECRET?.trim().length ?? 0) < 32) {
    errors.push(
      "STAGING_SESSION_EXCHANGE_SIGNING_SECRET is missing or too short",
    );
  }
  const signingSecret = env.STAGING_SESSION_EXCHANGE_SIGNING_SECRET?.trim();
  if (
    signingSecret &&
    [
      env.STEWARD_JWT_SECRET,
      env.STEWARD_SESSION_SECRET,
      env.ELIZA_SERVICE_JWT_SECRET,
    ].some((value) => value?.trim() === signingSecret)
  ) {
    errors.push(
      "STAGING_SESSION_EXCHANGE_SIGNING_SECRET must be dedicated to staging QA sessions",
    );
  }
  if (!exactUuidList(env.STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS)) {
    errors.push(
      "STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS must contain 1-100 exact UUIDs",
    );
  }
  if (!exactUuidList(env.STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS)) {
    errors.push(
      "STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS must contain 1-100 exact UUIDs",
    );
  }
  if (!exactUuidList(env.STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS)) {
    errors.push(
      "STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS must contain 1-100 exact UUIDs",
    );
  }
  return errors;
}

function runCli() {
  const errors = validateStagingSessionCutoverConfig(process.env);
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
