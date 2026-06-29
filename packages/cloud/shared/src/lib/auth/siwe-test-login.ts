/**
 * Headless SIWE ("Sign-In With Ethereum") login for e2e + local dev.
 *
 * This performs the GENUINE EIP-4361 handshake against a running cloud-api:
 *
 *   1. GET  /api/auth/siwe/nonce   → one-time nonce + the server's own
 *                                    `domain`/`uri` (so the domain check always
 *                                    matches whatever the API is configured as).
 *   2. Build the EIP-4361 message and sign it with a throwaway Ethereum wallet
 *      (real secp256k1 signature via viem).
 *   3. POST /api/auth/siwe/verify  → the server re-validates the signature,
 *      consumes the nonce, find-or-creates a FREE account for the wallet
 *      address, and returns a real API key.
 *
 * Nothing here is mocked: the signature, nonce, and domain are all validated by
 * the real server code (`validateAndConsumeSIWE`). What it "bypasses" is only the
 * interactive browser-wallet UI — the test owns the private key and signs
 * headlessly, so login works deterministically in dev and CI with no wallet
 * extension and no human in the loop.
 *
 * Use the returned `apiKey` as `Authorization: Bearer <apiKey>` / `X-API-Key`
 * for every subsequent authenticated request (create agent, send chat, …) —
 * this is the credential that drives programmatic e2e flows.
 */

import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

export interface SiweTestLoginResult {
  /** Real API key for the (free) account — use as Bearer / X-API-Key. */
  apiKey: string;
  /** Checksummed wallet address that signed in. */
  address: string;
  /** Eliza Cloud user id. */
  userId: string;
  /** Eliza Cloud organization id. */
  organizationId: string;
  /** True when this wallet had no prior account (a fresh free account was created). */
  isNewAccount: boolean;
  /** The private key used (generated if not supplied) — lets a test reuse the same wallet. */
  privateKey: Hex;
}

export interface SiweTestLoginOptions {
  /** Base URL of the running cloud-api, e.g. `http://127.0.0.1:8787`. No trailing slash needed. */
  baseUrl: string;
  /**
   * Deterministic wallet private key. Omit to generate a fresh throwaway wallet
   * (a brand-new free account). Pass a fixed key to sign in as the same account
   * across runs.
   */
  privateKey?: Hex;
  /** EVM chain id to request in the nonce (default 1 / mainnet). */
  chainId?: number;
  /** Override `fetch` — pass a shim bridged to Hono's `app.request()` for in-process tests. */
  fetchImpl?: typeof fetch;
}

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  version: string;
  statement: string;
}

interface VerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: {
    id: string;
    wallet_address: string | null;
    organization_id: string;
  };
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

/**
 * Run the real SIWE login handshake and return a usable API key for a free
 * Eliza Cloud account. Throws (with the server status + body) on any failure so
 * a broken login surfaces loudly instead of silently producing a dead key.
 */
export async function siweTestLogin(options: SiweTestLoginOptions): Promise<SiweTestLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const privateKey = options.privateKey ?? generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const requestedChainId = options.chainId ?? 1;

  const nonceRes = await fetchImpl(`${baseUrl}/api/auth/siwe/nonce?chainId=${requestedChainId}`, {
    headers: { accept: "application/json" },
  });
  if (!nonceRes.ok) {
    throw new Error(`SIWE nonce request failed: ${nonceRes.status} ${await readBody(nonceRes)}`);
  }
  const nonce = (await nonceRes.json()) as NonceResponse;

  // Build the EIP-4361 message from the server's own domain/uri so the
  // server-side domain check always matches its configured app host.
  const message = createSiweMessage({
    address: account.address,
    chainId: nonce.chainId || requestedChainId,
    domain: nonce.domain,
    nonce: nonce.nonce,
    uri: nonce.uri,
    version: (nonce.version as "1") || "1",
    statement: nonce.statement,
    issuedAt: new Date(),
  });
  const signature = await account.signMessage({ message });

  const verifyRes = await fetchImpl(`${baseUrl}/api/auth/siwe/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Some deployments require an Origin/Referer; supply the server's own uri.
      origin: nonce.uri,
    },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    throw new Error(`SIWE verify failed: ${verifyRes.status} ${await readBody(verifyRes)}`);
  }
  const verified = (await verifyRes.json()) as VerifyResponse;

  if (!verified.apiKey || !verified.user?.id || !verified.user.organization_id) {
    throw new Error(`SIWE verify returned an incomplete session: ${JSON.stringify(verified)}`);
  }

  return {
    apiKey: verified.apiKey,
    address: verified.address,
    userId: verified.user.id,
    organizationId: verified.user.organization_id,
    isNewAccount: verified.isNewAccount,
    privateKey,
  };
}
