#!/usr/bin/env node
/**
 * cloud-siwe-login.mjs
 *
 * Mint an Eliza Cloud API key by signing an EIP-4361 (SIWE) message with a
 * local wallet private key. Used for build-testing mode when the dashboard
 * UI for issuing API keys is unavailable.
 *
 * Flow (matches cloud-pr484/apps/api/auth/siwe/{nonce,verify}/route.ts):
 *   1. GET  {baseUrl}/api/auth/siwe/nonce?chainId=<id>
 *      → { nonce, domain, uri, chainId, version, statement }
 *   2. Build SIWE message with viem/siwe.createSiweMessage
 *   3. Sign with privateKeyToAccount(pk).signMessage(...)
 *   4. POST {baseUrl}/api/auth/siwe/verify { message, signature }
 *      → { apiKey, address, isNewAccount, user, organization }
 *
 * Usage:
 *   MILADY_TEST_WALLET_PRIVATE_KEY=0x... \
 *   node scripts/cloud-siwe-login.mjs [--base-url https://www.elizacloud.ai] [--chain-id 1] [--json]
 *
 * The output (default) is a single line `MILADY_DEV_CLOUD_API_KEY=<key>` so it
 * can be eval'd into a shell. Pass --json for the full verify response.
 */

import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";

function parseArgs(argv) {
  const args = { baseUrl: null, chainId: 1, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--chain-id") args.chainId = Number.parseInt(argv[++i], 10);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.error(
        "Usage: MILADY_TEST_WALLET_PRIVATE_KEY=0x... node scripts/cloud-siwe-login.mjs [--base-url URL] [--chain-id N] [--json]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl =
    args.baseUrl ??
    process.env.ELIZAOS_CLOUD_BASE_URL ??
    "https://www.elizacloud.ai";

  const pk = process.env.MILADY_TEST_WALLET_PRIVATE_KEY;
  if (!pk) {
    console.error(
      "MILADY_TEST_WALLET_PRIVATE_KEY is required (0x-prefixed 32-byte hex).",
    );
    process.exit(2);
  }
  const account = privateKeyToAccount(pk);

  const nonceUrl = `${baseUrl.replace(/\/$/, "")}/api/auth/siwe/nonce?chainId=${args.chainId}`;
  const nonceRes = await fetch(nonceUrl, { headers: { Accept: "application/json" } });
  if (!nonceRes.ok) {
    const body = await nonceRes.text();
    throw new Error(`SIWE nonce fetch failed (${nonceRes.status}): ${body}`);
  }
  const nonceBody = await nonceRes.json();
  const { nonce, domain, uri, chainId, version, statement } = nonceBody;
  if (!nonce || !domain || !uri) {
    throw new Error(`Malformed nonce response: ${JSON.stringify(nonceBody)}`);
  }

  const issuedAt = new Date();
  const message = createSiweMessage({
    address: account.address,
    chainId: Number(chainId) || args.chainId,
    domain,
    nonce,
    statement,
    uri,
    version: version ?? "1",
    issuedAt,
  });

  const signature = await account.signMessage({ message });

  const verifyUrl = `${baseUrl.replace(/\/$/, "")}/api/auth/siwe/verify`;
  const verifyRes = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ message, signature }),
  });
  const verifyBody = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || typeof verifyBody.apiKey !== "string") {
    throw new Error(
      `SIWE verify failed (${verifyRes.status}): ${JSON.stringify(verifyBody)}`,
    );
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(verifyBody, null, 2)}\n`);
  } else {
    process.stdout.write(`MILADY_DEV_CLOUD_API_KEY=${verifyBody.apiKey}\n`);
    process.stderr.write(
      `[cloud-siwe-login] address=${verifyBody.address} isNewAccount=${verifyBody.isNewAccount} userId=${verifyBody.user?.id ?? "?"} orgId=${verifyBody.user?.organization_id ?? "?"}\n`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
