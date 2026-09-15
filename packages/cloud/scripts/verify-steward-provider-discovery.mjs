#!/usr/bin/env node
/**
 * Verifies anonymous Steward provider discovery at release boundaries without
 * printing response bodies, tenant data, headers, or credential material.
 */

import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_CONTAINER_ENTRIES = 256;
const MAX_JSON_NODES = 2_048;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const ENVIRONMENT_CONTRACTS = Object.freeze({
  staging: Object.freeze({
    tenantId: "elizacloud-staging",
    upstreamOrigin: "https://steward-api-staging.up.railway.app",
    proxyOrigins: Object.freeze([
      "https://api-staging.eliza.app",
      "https://cloud-staging.eliza.app",
      "https://staging.eliza.app",
      "https://develop.eliza-app.pages.dev",
    ]),
  }),
});

const SURFACES = new Set(["upstream", "proxy"]);
const REQUIRED_BOOLEAN_FIELDS = [
  "passkey",
  "email",
  "siwe",
  "siws",
  "google",
  "discord",
  "github",
  "twitter",
];
const OPTIONAL_BOOLEAN_FIELDS = [
  "sms",
  "whatsapp",
  "totp",
  "telegram",
  "farcaster",
  "linkedin",
  "spotify",
  "twitch",
  "instagram",
  "line",
  "jwt",
];
const OPTIONAL_STRING_ARRAY_FIELDS = ["oidc", "disabled"];
const CAPTCHA_PROVIDERS = new Set(["turnstile", "hcaptcha"]);
const CAPTCHA_REQUIREMENTS = new Set(["email_otp", "sms_otp"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isCaptcha(value) {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
    return false;
  }
  if (
    Object.hasOwn(value, "provider") &&
    (typeof value.provider !== "string" ||
      !CAPTCHA_PROVIDERS.has(value.provider))
  ) {
    return false;
  }
  if (Object.hasOwn(value, "siteKey") && typeof value.siteKey !== "string") {
    return false;
  }
  if (Object.hasOwn(value, "requiredFor")) {
    if (!isStringArray(value.requiredFor)) return false;
    if (!value.requiredFor.every((entry) => CAPTCHA_REQUIREMENTS.has(entry))) {
      return false;
    }
  }
  return true;
}

function isProviderDiscoveryData(value) {
  if (!isRecord(value)) return false;
  if (
    !REQUIRED_BOOLEAN_FIELDS.every(
      (field) =>
        Object.hasOwn(value, field) && typeof value[field] === "boolean",
    )
  ) {
    return false;
  }
  if (!Object.hasOwn(value, "oauth") || !isStringArray(value.oauth)) {
    return false;
  }
  if (
    !OPTIONAL_BOOLEAN_FIELDS.every(
      (field) =>
        !Object.hasOwn(value, field) || typeof value[field] === "boolean",
    )
  ) {
    return false;
  }
  if (
    !OPTIONAL_STRING_ARRAY_FIELDS.every(
      (field) => !Object.hasOwn(value, field) || isStringArray(value[field]),
    )
  ) {
    return false;
  }
  return !Object.hasOwn(value, "captcha") || isCaptcha(value.captcha);
}

export function isProviderDiscoveryPayload(value) {
  if (!isRecord(value) || value.ok !== true || Object.hasOwn(value, "error")) {
    return false;
  }
  if (Object.hasOwn(value, "success") && value.success !== true) return false;

  const hasNestedData = !isProviderDiscoveryData(value);
  if (hasNestedData && !Object.hasOwn(value, "data")) return false;
  return isProviderDiscoveryData(hasNestedData ? value.data : value);
}

/**
 * Keep this release-boundary parser in lockstep with parseProvidersJson in
 * packages/cloud/api/src/steward/embedded.ts. The real-handler parity tests
 * protect duplicate-key, dangerous-key, depth, and flat-vs-nested semantics.
 */
export function parseProviderDiscoveryJson(text) {
  let position = 0;
  let nodes = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text[position] ?? "")) position += 1;
  };
  const parseString = () => {
    if (text[position] !== '"') throw new Error("expected JSON string");
    const start = position++;
    while (position < text.length) {
      if (text[position] === "\\") {
        position += 2;
        continue;
      }
      if (text[position++] === '"') {
        return JSON.parse(text.slice(start, position));
      }
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error("provider JSON complexity exceeded");
    }
    skipWhitespace();
    if (text[position] === "{") {
      position += 1;
      skipWhitespace();
      const keys = new Set();
      let entries = 0;
      if (text[position] === "}") {
        position += 1;
        return;
      }
      while (true) {
        const key = parseString();
        if (keys.has(key) || DANGEROUS_JSON_KEYS.has(key)) {
          throw new Error("unsafe or duplicate provider JSON key");
        }
        keys.add(key);
        entries += 1;
        if (entries > MAX_CONTAINER_ENTRIES) {
          throw new Error("provider object too large");
        }
        skipWhitespace();
        if (text[position++] !== ":") throw new Error("expected colon");
        parseValue(depth + 1);
        skipWhitespace();
        const separator = text[position++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("expected object separator");
        skipWhitespace();
      }
    }
    if (text[position] === "[") {
      position += 1;
      skipWhitespace();
      let entries = 0;
      if (text[position] === "]") {
        position += 1;
        return;
      }
      while (true) {
        entries += 1;
        if (entries > MAX_CONTAINER_ENTRIES) {
          throw new Error("provider array too large");
        }
        parseValue(depth + 1);
        skipWhitespace();
        const separator = text[position++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("expected array separator");
      }
    }
    if (text[position] === '"') {
      parseString();
      return;
    }
    const start = position;
    while (position < text.length && !/[\s,\]}]/.test(text[position])) {
      position += 1;
    }
    JSON.parse(text.slice(start, position));
  };
  parseValue(0);
  skipWhitespace();
  if (position !== text.length) throw new Error("trailing JSON data");
  return JSON.parse(text);
}

function requiredEnvironment(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!Object.hasOwn(ENVIRONMENT_CONTRACTS, normalized ?? "")) {
    throw new Error("--environment must be staging");
  }
  return normalized;
}

function requiredSurface(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized || !SURFACES.has(normalized)) {
    throw new Error("--surface must be upstream or proxy");
  }
  return normalized;
}

function requiredOrigin(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("--base-url is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 CLI URL parsing fails closed without reflecting input.
    throw new Error("--base-url must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base-url must be an HTTPS origin");
  }
  return url.origin;
}

function validateProviderDiscoveryConfig(config) {
  const environment = requiredEnvironment(config.environment);
  const surface = requiredSurface(config.surface);
  const baseUrl = requiredOrigin(config.baseUrl);
  const contract = ENVIRONMENT_CONTRACTS[environment];
  const allowedOrigins =
    surface === "upstream" ? [contract.upstreamOrigin] : contract.proxyOrigins;
  if (!allowedOrigins.includes(baseUrl)) {
    throw new Error(
      `--base-url is not a canonical ${environment} ${surface} origin`,
    );
  }
  return { baseUrl, environment, surface };
}

export function parseProviderDiscoveryArgs(argv) {
  if (argv.length % 2 !== 0) {
    throw new Error("Arguments must be flag-value pairs");
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error("Arguments must use supported flag-value pairs");
    }
    if (!["--base-url", "--environment", "--surface"].includes(flag)) {
      throw new Error("Unsupported argument");
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag, value);
  }

  return validateProviderDiscoveryConfig({
    baseUrl: values.get("--base-url"),
    environment: values.get("--environment"),
    surface: values.get("--surface"),
  });
}

async function readBoundedBody(response) {
  if (!response.body) throw new Error("provider discovery body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        tooLarge = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // error-policy:J1 the verifier boundary translates body-read failures to a
    // privacy-safe error and never republishes upstream bytes or metadata.
    throw new Error(
      tooLarge
        ? "provider discovery body exceeds the safe limit"
        : "provider discovery body could not be read",
    );
  } finally {
    reader.releaseLock();
  }
  if (tooLarge) {
    throw new Error("provider discovery body exceeds the safe limit");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // error-policy:J3 invalid UTF-8 is rejected without logging bytes.
    throw new Error("provider discovery body is not valid UTF-8");
  }
}

async function fetchProviderDiscoveryBoundary({
  baseUrl,
  path,
  headers,
  surface,
  method,
  fetchImpl,
}) {
  const boundary = method === "HEAD" ? `${surface} HEAD` : surface;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // error-policy:J1 network and timeout failures become a stable deploy-gate
    // error without exposing a URL, tenant, request header, or provider detail.
    throw new Error(`provider discovery ${boundary} request failed`);
  }
  if (response.status !== 200) {
    throw new Error(
      `provider discovery ${boundary} returned HTTP ${response.status}`,
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new Error(
      `provider discovery ${boundary} returned a non-JSON media type`,
    );
  }
  if (
    surface === "proxy" &&
    response.headers.get("x-eliza-steward-path") !== "thin"
  ) {
    throw new Error(
      `provider discovery ${boundary} did not traverse the thin Steward path`,
    );
  }
  return response;
}

export async function verifyStewardProviderDiscovery(
  config,
  { fetchImpl = fetch } = {},
) {
  const {
    baseUrl,
    environment: deployEnvironment,
    surface: checkedSurface,
  } = validateProviderDiscoveryConfig(config);
  const contract = ENVIRONMENT_CONTRACTS[deployEnvironment];
  const path =
    checkedSurface === "upstream"
      ? "/auth/providers"
      : "/steward/auth/providers";
  const headers = new Headers({ Accept: "application/json" });
  if (checkedSurface === "upstream") {
    headers.set("x-steward-tenant", contract.tenantId);
  }

  const response = await fetchProviderDiscoveryBoundary({
    baseUrl,
    path,
    headers,
    surface: checkedSurface,
    method: "GET",
    fetchImpl,
  });

  const body = await readBoundedBody(response);
  let payload;
  try {
    payload = parseProviderDiscoveryJson(body);
  } catch {
    // error-policy:J3 invalid JSON becomes a stable result without body output.
    throw new Error(
      `provider discovery ${checkedSurface} returned invalid JSON`,
    );
  }
  if (!isProviderDiscoveryPayload(payload)) {
    throw new Error(
      `provider discovery ${checkedSurface} returned an invalid provider contract`,
    );
  }
  if (checkedSurface === "proxy") {
    await fetchProviderDiscoveryBoundary({
      baseUrl,
      path,
      headers,
      surface: checkedSurface,
      method: "HEAD",
      fetchImpl,
    });
  }
  return { environment: deployEnvironment, surface: checkedSurface };
}

export async function verifyStewardProviderDiscoveryWithRetry(
  config,
  {
    fetchImpl = fetch,
    attempts = DEFAULT_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleepImpl = (delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("attempts must be an integer from 1 through 10");
  }
  const checkedConfig = validateProviderDiscoveryConfig(config);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyStewardProviderDiscovery(checkedConfig, { fetchImpl });
    } catch (error) {
      // error-policy:J1 retain only the already-sanitized boundary error for a
      // bounded retry; no response object or body crosses this boundary.
      lastError = error;
      if (attempt < attempts) await sleepImpl(retryDelayMs);
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : "unknown safe failure";
  throw new Error(
    `provider discovery failed after ${attempts} attempts: ${detail}`,
  );
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = fetch, log = console.log, sleepImpl } = {},
) {
  const config = parseProviderDiscoveryArgs(argv);
  const result = await verifyStewardProviderDiscoveryWithRetry(config, {
    fetchImpl,
    ...(sleepImpl ? { sleepImpl } : {}),
  });
  log(
    `Verified anonymous Steward provider discovery through the ${result.surface} boundary for ${result.environment}.`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    // error-policy:J1 the process boundary emits only errors already reduced
    // to stable, privacy-safe verifier messages.
    console.error(
      `verify-steward-provider-discovery: ${error instanceof Error ? error.message : "unknown safe failure"}`,
    );
    process.exitCode = 1;
  });
}
