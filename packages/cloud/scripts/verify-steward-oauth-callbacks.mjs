#!/usr/bin/env node
/**
 * Verify the externally managed Steward sign-in configuration for a deployed
 * Eliza browser host. OAuth probes stop at the provider redirect, while the
 * wallet probe requests only the public nonce used before SIWE/SIWS signing;
 * neither path authenticates a user or creates an Eliza session.
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const PROVIDER_DESTINATIONS = Object.freeze({
  discord: {
    origin: "https://discord.com",
    pathname: "/api/oauth2/authorize",
  },
  google: {
    origin: "https://accounts.google.com",
    pathname: "/o/oauth2/v2/auth",
  },
});

// Provider callbacks terminate on the public Steward API authority, not on
// either browser host. Both staging browser hosts share the isolated staging
// challenge store through api-staging.eliza.app; production retains the
// established direct Steward callback.
const CANONICAL_STEWARD_CALLBACK_BASE_URLS = Object.freeze({
  staging: "https://api-staging.eliza.app/steward",
  production: "https://eliza.steward.fi",
});

const DEPLOY_ENVIRONMENTS = new Set(["staging", "production"]);
const OAUTH_STATE_PATTERN = /^[0-9a-f]{32}$/;

// ERC-4361 defines a SIWE nonce as at least eight ASCII alphanumeric
// characters. Steward shares this nonce across its SIWE and SIWS launch paths,
// so accepting a weaker shape would let the deploy gate bless an unusable
// wallet response.
const WALLET_NONCE_PATTERN = /^[A-Za-z0-9]{8,}$/;

function requiredUrl(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${flag} must use https`);
  }
  return url;
}

function requiredEnvironment(value) {
  const environment = value?.trim().toLowerCase();
  if (!environment) throw new Error("--environment is required");
  if (!DEPLOY_ENVIRONMENTS.has(environment)) {
    throw new Error("--environment must be staging or production");
  }
  return environment;
}

export function parseStewardCallbackProbeArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${flag ?? "<end>"}`);
    }
    values.set(flag, value);
  }

  const baseUrl = requiredUrl(values.get("--base-url"), "--base-url");
  const callbackUrl = requiredUrl(
    values.get("--callback-url"),
    "--callback-url",
  );
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("--base-url must be an HTTPS origin");
  }
  if (
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.pathname !== "/login" ||
    callbackUrl.search ||
    callbackUrl.hash
  ) {
    throw new Error("--callback-url must be the canonical HTTPS /login URL");
  }
  const tenantId = values.get("--tenant-id")?.trim();
  if (!tenantId) throw new Error("--tenant-id is required");
  const environment = requiredEnvironment(values.get("--environment"));
  if (callbackUrl.origin !== baseUrl.origin) {
    throw new Error("--callback-url must use the --base-url origin");
  }

  return {
    baseUrl: baseUrl.origin,
    callbackUrl: callbackUrl.toString(),
    environment,
    tenantId,
  };
}

function pkceChallenge() {
  return createHash("sha256")
    .update("eliza-canonical-callback-deploy-probe")
    .digest("base64url");
}

export async function verifyStewardOAuthCallbacks(
  { baseUrl, callbackUrl, environment, tenantId },
  { fetchImpl = fetch } = {},
) {
  const deployEnvironment = requiredEnvironment(environment);
  const results = [];
  for (const [provider, expectedDestination] of Object.entries(
    PROVIDER_DESTINATIONS,
  )) {
    const launchStates = new Set();
    for (let launch = 0; launch < 2; launch += 1) {
      const query = new URLSearchParams({
        tenant_id: tenantId,
        redirect_uri: callbackUrl,
        code_challenge: pkceChallenge(),
        code_challenge_method: "S256",
        state: "canonical-callback-deploy-probe",
      });
      const endpoint = `${baseUrl}/steward/auth/oauth/${provider}/authorize?${query}`;
      const response = await fetchImpl(endpoint, { redirect: "manual" });
      const location = response.headers.get("location");

      if (response.status !== 302 || !location) {
        throw new Error(
          `${provider} callback probe returned HTTP ${response.status}; expected a provider redirect`,
        );
      }

      const destination = new URL(location);
      if (
        destination.origin !== expectedDestination.origin ||
        destination.pathname !== expectedDestination.pathname ||
        destination.username !== "" ||
        destination.password !== "" ||
        destination.hash !== ""
      ) {
        throw new Error(
          `${provider} callback probe reached unexpected provider destination ${destination.origin}${destination.pathname}`,
        );
      }
      const providerStates = destination.searchParams.getAll("state");
      const providerState = providerStates[0];
      if (
        providerStates.length !== 1 ||
        !providerState ||
        !OAUTH_STATE_PATTERN.test(providerState)
      ) {
        throw new Error(
          `${provider} callback probe returned an invalid provider state`,
        );
      }
      launchStates.add(providerState);

      const callbackBaseUrl = CANONICAL_STEWARD_CALLBACK_BASE_URLS[deployEnvironment];
      const expectedProviderCallback = `${callbackBaseUrl}/auth/oauth/${encodeURIComponent(provider)}/callback`;
      const providerCallbacks = destination.searchParams.getAll("redirect_uri");
      const actualProviderCallback = providerCallbacks[0];
      if (
        providerCallbacks.length !== 1 ||
        actualProviderCallback !== expectedProviderCallback
      ) {
        throw new Error(
          `${provider} callback probe used ${actualProviderCallback ?? "no redirect_uri"}; expected ${expectedProviderCallback}`,
        );
      }
    }
    if (launchStates.size !== 2) {
      throw new Error(
        `${provider} callback probe reused provider state across independent launches`,
      );
    }
    results.push({
      provider,
      destinationHostname: new URL(expectedDestination.origin).hostname,
    });
  }
  return results;
}

export async function verifyStewardWalletOrigin(
  { baseUrl },
  { fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`${baseUrl}/steward/auth/nonce`, {
    // Same-origin browser GETs omit Origin. The embedded proxy must synthesize
    // the canonical browser origin before forwarding the request to Steward.
    headers: { Accept: "application/json" },
    redirect: "manual",
  });

  if (response.status !== 200) {
    throw new Error(
      `wallet origin probe returned HTTP ${response.status}; expected a nonce response`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J1 Translate the deployed HTTP boundary into a fail-closed probe result.
    throw new Error("wallet origin probe returned invalid JSON", { cause });
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.nonce !== "string" ||
    !WALLET_NONCE_PATTERN.test(payload.nonce)
  ) {
    throw new Error("wallet origin probe returned an invalid nonce");
  }

  return { origin: baseUrl };
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = fetch, log = console.log } = {},
) {
  const config = parseStewardCallbackProbeArgs(argv);
  const results = await verifyStewardOAuthCallbacks(config, { fetchImpl });
  for (const result of results) {
    log(
      `Verified ${result.provider} canonical callback via ${result.destinationHostname}.`,
    );
  }
  const wallet = await verifyStewardWalletOrigin(config, { fetchImpl });
  log(`Verified canonical wallet origin ${wallet.origin}.`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `verify-steward-oauth-callbacks: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
