#!/usr/bin/env bun
/**
 * Validates non-secret Steward tenant email callback values against the
 * canonical Eliza app origins without reading or mutating external state.
 */
import { pathToFileURL } from "node:url";
import { ELIZA_DOMAIN_CONTRACTS } from "../../shared/src/elizacloud/domain-contract.ts";

const CALLBACK_PATH = "/auth/callback/email";
const ENVIRONMENTS = new Set(["production", "staging"]);
const ALLOWED_FLAGS = new Set([
  "--environment",
  "--magic-link-base-url",
  "--callback-path",
]);

function readFlags(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !ALLOWED_FLAGS.has(flag) ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      throw new Error("Invalid arguments");
    }
    values.set(flag, value);
  }
  return values;
}

export function parseStewardEmailCallbackConfigArgs(argv) {
  const values = readFlags(argv);
  const environment = values.get("--environment")?.trim();
  if (!environment) throw new Error("--environment is required");
  const magicLinkBaseUrl = values.get("--magic-link-base-url")?.trim();
  if (!magicLinkBaseUrl) throw new Error("--magic-link-base-url is required");
  const callbackPath = values.get("--callback-path")?.trim();
  if (!callbackPath) throw new Error("--callback-path is required");
  return { environment, magicLinkBaseUrl, callbackPath };
}

export function validateStewardEmailCallbackConfig(config) {
  if (!ENVIRONMENTS.has(config.environment)) {
    throw new Error("--environment must be production or staging");
  }
  const expectedOrigin =
    ELIZA_DOMAIN_CONTRACTS[config.environment].cloudAppOrigin;
  let base;
  try {
    base = new URL(config.magicLinkBaseUrl);
  } catch {
    // error-policy:J3 Replace engine parser details with a safe diagnostic.
    throw new Error("magic-link base URL is invalid");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.origin !== expectedOrigin ||
    (base.pathname !== "/" && base.pathname !== "") ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      `magic-link base must be the canonical ${config.environment} app origin ${expectedOrigin}`,
    );
  }
  if (config.callbackPath !== CALLBACK_PATH) {
    throw new Error(`callback path must be ${CALLBACK_PATH}`);
  }
  return {
    environment: config.environment,
    callbackUrl: `${expectedOrigin}${CALLBACK_PATH}`,
  };
}

export function main(argv = process.argv.slice(2)) {
  const result = validateStewardEmailCallbackConfig(
    parseStewardEmailCallbackConfigArgs(argv),
  );
  console.log(
    `Verified ${result.environment} Steward email callback ${result.callbackUrl}.`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 Translate validation failures at the CLI boundary.
    console.error(
      `verify-steward-email-callback-config: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
