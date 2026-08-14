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
  discord: "discord.com",
  google: "accounts.google.com",
});

function requiredUrl(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${flag} must use https`);
  }
  return url;
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
  const tenantId = values.get("--tenant-id")?.trim();
  if (!tenantId) throw new Error("--tenant-id is required");

  return {
    baseUrl: baseUrl.origin,
    callbackUrl: callbackUrl.toString(),
    tenantId,
  };
}

function pkceChallenge() {
  return createHash("sha256")
    .update("eliza-canonical-callback-deploy-probe")
    .digest("base64url");
}

export async function verifyStewardOAuthCallbacks(
  { baseUrl, callbackUrl, tenantId },
  { fetchImpl = fetch } = {},
) {
  const results = [];
  for (const [provider, expectedHostname] of Object.entries(
    PROVIDER_DESTINATIONS,
  )) {
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
      destination.protocol !== "https:" ||
      destination.hostname !== expectedHostname
    ) {
      throw new Error(
        `${provider} callback probe reached unexpected provider host ${destination.hostname}`,
      );
    }
    results.push({ provider, destinationHostname: destination.hostname });
  }
  return results;
}

export async function verifyStewardWalletOrigin(
  { baseUrl },
  { fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(`${baseUrl}/steward/auth/nonce`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: baseUrl,
    },
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
    payload.nonce.length === 0
  ) {
    throw new Error("wallet origin probe returned no nonce");
  }

  return { origin: baseUrl };
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseStewardCallbackProbeArgs(argv);
  const results = await verifyStewardOAuthCallbacks(config);
  for (const result of results) {
    console.log(
      `Verified ${result.provider} canonical callback via ${result.destinationHostname}.`,
    );
  }
  const wallet = await verifyStewardWalletOrigin(config);
  console.log(`Verified canonical wallet origin ${wallet.origin}.`);
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
