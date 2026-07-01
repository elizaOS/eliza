#!/usr/bin/env bun
/**
 * Headless SIWE ("Sign-In With Ethereum") login — dev + CI smoke.
 *
 * Creates/uses a throwaway Ethereum wallet, runs the GENUINE EIP-4361 handshake
 * against a cloud-api (nonce → sign → verify), and prints a real API key for a
 * free account. No browser wallet, no human, no mock — the signature, nonce, and
 * domain are validated by the real server.
 *
 * Usage:
 *   bun run cloud:login:test-wallet                      # against https://api.elizacloud.ai
 *   bun run cloud:login:test-wallet -- --base http://127.0.0.1:8787
 *   bun run cloud:login:test-wallet -- --json            # machine-readable
 *   PRIVATE_KEY=0x... bun run cloud:login:test-wallet    # reuse a fixed wallet
 *
 * CI: use as a login gate before driving authenticated flows — exits non-zero if
 * login fails so a broken auth path turns the job red.
 */

import { siweTestLogin } from "@elizaos/cloud-shared/lib/auth/siwe-test-login";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const baseUrl = arg(
  "base",
  process.env.SIWE_BASE ?? "https://api.elizacloud.ai",
);
const asJson = process.argv.includes("--json");
const privateKey = process.env.PRIVATE_KEY?.trim() || undefined;

const startedAt = Date.now();
let session;
try {
  session = await siweTestLogin({ baseUrl, privateKey });
} catch (err) {
  console.error(
    `[siwe-login] FAILED against ${baseUrl}:`,
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
const loginMs = Date.now() - startedAt;

// Prove the key authorizes a real request.
let balanceStatus = 0;
let balance = null;
try {
  const res = await fetch(`${baseUrl}/api/v1/credits/balance`, {
    headers: { authorization: `Bearer ${session.apiKey}` },
  });
  balanceStatus = res.status;
  if (res.ok) balance = (await res.json())?.balance ?? null;
} catch {
  // network probe failure is non-fatal to the login itself
}

if (asJson) {
  console.log(
    JSON.stringify({ ...session, baseUrl, loginMs, balanceStatus, balance }),
  );
} else {
  console.log(`[siwe-login] OK  ${baseUrl}`);
  console.log(`  address      ${session.address}`);
  console.log(`  userId       ${session.userId}`);
  console.log(`  orgId        ${session.organizationId}`);
  console.log(`  isNewAccount ${session.isNewAccount}`);
  console.log(
    `  apiKey       ${session.apiKey.slice(0, 12)}…(${session.apiKey.length} chars)`,
  );
  console.log(`  loginMs      ${loginMs}`);
  console.log(
    `  credits      ${balance} (GET /api/v1/credits/balance -> ${balanceStatus})`,
  );
}

if (balanceStatus && balanceStatus !== 200) {
  console.error(
    `[siwe-login] WARN: API key did not authorize /api/v1/credits/balance (status ${balanceStatus})`,
  );
  process.exit(2);
}
