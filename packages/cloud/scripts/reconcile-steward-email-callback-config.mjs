#!/usr/bin/env bun
/**
 * Reconciles staging Steward's tenant-scoped email callback with the canonical
 * Eliza app origin, then reads it back so deployment fails on persistent drift.
 */
import { pathToFileURL } from "node:url";
import { ELIZA_DOMAIN_CONTRACTS } from "../../shared/src/elizacloud/domain-contract.ts";
import { validateStewardEmailCallbackConfig } from "./verify-steward-email-callback-config.mjs";

const CALLBACK_PATH = "/auth/callback/email";

function requiredEnvironmentValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function firstPlatformKey(value) {
  const key = value
    .split(",")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!key) throw new Error("STEWARD_PLATFORM_KEYS is required");
  return key;
}

function canonicalApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 Reject malformed deployment configuration explicitly.
    throw new Error("STEWARD_API_URL must be an absolute HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("STEWARD_API_URL must be an absolute HTTPS origin");
  }
  return url.origin;
}

function readEmailConfig(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Steward email config response was malformed");
  }
  const data = payload.data;
  if (!data || typeof data !== "object") {
    throw new Error("Steward email config response was malformed");
  }
  if (data.emailConfig === null) return {};
  if (!data.emailConfig || typeof data.emailConfig !== "object") {
    throw new Error("Steward email config response was malformed");
  }
  return data.emailConfig;
}

async function stewardRequest({ fetchImpl, url, platformKey, init }) {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Steward-Platform-Key", platformKey);
  const response = await fetchImpl(url, {
    ...init,
    headers,
    redirect: "error",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // error-policy:J3 A non-JSON response is invalid at this API boundary.
  }
  if (!response.ok) {
    throw new Error(
      `Steward email config request failed with HTTP ${response.status}`,
    );
  }
  return payload;
}

export async function reconcileStewardEmailCallbackConfig({
  environment,
  stewardApiUrl,
  tenantId,
  platformKey,
  fetchImpl = fetch,
}) {
  if (environment !== "staging") {
    throw new Error("ENVIRONMENT must be staging");
  }
  const expectedOrigin = ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;
  const emailConfigUrl = new URL(
    `/platform/tenants/${encodeURIComponent(tenantId)}/email-config`,
    canonicalApiOrigin(stewardApiUrl),
  );
  const current = readEmailConfig(
    await stewardRequest({ fetchImpl, url: emailConfigUrl, platformKey }),
  );

  if (
    current.magicLinkBaseUrl !== expectedOrigin ||
    current.magicLinkCallbackPath !== CALLBACK_PATH
  ) {
    await stewardRequest({
      fetchImpl,
      url: emailConfigUrl,
      platformKey,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          magicLinkBaseUrl: expectedOrigin,
          magicLinkCallbackPath: CALLBACK_PATH,
        }),
      },
    });
  }

  const verified = readEmailConfig(
    await stewardRequest({ fetchImpl, url: emailConfigUrl, platformKey }),
  );
  return validateStewardEmailCallbackConfig({
    environment,
    magicLinkBaseUrl: verified.magicLinkBaseUrl,
    callbackPath: verified.magicLinkCallbackPath,
  });
}

export async function main(environment = process.env) {
  const result = await reconcileStewardEmailCallbackConfig({
    environment: requiredEnvironmentValue(environment, "ENVIRONMENT"),
    stewardApiUrl: requiredEnvironmentValue(environment, "STEWARD_API_URL"),
    tenantId: requiredEnvironmentValue(environment, "STEWARD_TENANT_ID"),
    platformKey: firstPlatformKey(
      requiredEnvironmentValue(environment, "STEWARD_PLATFORM_KEYS"),
    ),
  });
  console.log(
    `Reconciled ${result.environment} Steward email callback ${result.callbackUrl}.`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    // error-policy:J1 Translate reconciliation failures at the CLI boundary.
    console.error(
      `reconcile-steward-email-callback-config: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
