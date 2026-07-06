/**
 * Sign-In With Ethereum (EIP-4361) login to Eliza Cloud through an injected
 * EIP-1193 wallet provider (`window.ethereum`).
 *
 * This is the wallet leg of the Cloud sign-in: the same genuine handshake the
 * cloud API's `/api/auth/siwe/nonce` → `/api/auth/siwe/verify` pair validates
 * server-side (nonce consumption, EIP-191 signature recovery, find-or-create
 * account) — nothing is mocked. The verified session's API key is written to
 * the canonical steward-session store, so everything downstream (connection
 * polling, agent provisioning, cloud-only onboarding's welcome-back skip)
 * treats it exactly like any other Eliza Cloud session.
 *
 * Two consumers:
 *  - a real browser wallet, driven through the normal sign-in tap; and
 *  - the e2e test wallet (`platform/e2e-wallet.ts`), which device/e2e
 *    harnesses seed with a throwaway key so onboarding can be exercised end to
 *    end on simulators and phones with zero human interaction (#13377).
 *
 * Gotcha: the nonce request must carry NO query string — the production
 * deployment 500s on `?chainId=`; the response's own chainId/domain/uri are
 * authoritative for the message.
 */
import { logger } from "@elizaos/logger";
import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";

/** Minimal EIP-1193 surface the login needs. */
export interface InjectedEthereumProvider {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
  /** Set by the e2e test wallet so harness-only behavior can identify it. */
  isElizaE2eWallet?: boolean;
  /** Phantom multichain-injects itself as window.ethereum; never SIWE with it. */
  isPhantom?: boolean;
}

export function getInjectedEthereumProvider(): InjectedEthereumProvider | null {
  if (typeof window === "undefined") return null;
  const provider = (window as { ethereum?: unknown }).ethereum;
  if (
    provider &&
    typeof provider === "object" &&
    typeof (provider as InjectedEthereumProvider).request === "function"
  ) {
    // Phantom injects window.ethereum (isPhantom:true) but is a Solana wallet;
    // treating it as an EVM SIWE provider pops Phantom on a non-wallet sign-in.
    // Mirrors the /login wallet-buttons guard (wallet-buttons.tsx).
    if ((provider as InjectedEthereumProvider).isPhantom === true) return null;
    return provider as InjectedEthereumProvider;
  }
  return null;
}

interface SiweNonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  version?: string;
  statement?: string;
  chainId?: number;
}

function isNonceResponse(value: unknown): value is SiweNonceResponse {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.nonce === "string" &&
    typeof r.domain === "string" &&
    typeof r.uri === "string"
  );
}

/**
 * Compose the canonical EIP-4361 message. Built by hand (not viem's
 * `createSiweMessage`) so the login path stays free of the heavyweight viem
 * import — the server re-parses and validates every field, so there is no
 * drift risk a test wouldn't catch immediately.
 */
export function buildSiweMessage(args: {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  const lines = [
    `${args.domain} wants you to sign in with your Ethereum account:`,
    args.address,
    "",
  ];
  if (args.statement) lines.push(args.statement, "");
  lines.push(
    `URI: ${args.uri}`,
    `Version: ${args.version}`,
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
  );
  return lines.join("\n");
}

function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    // error-policy:J6 diagnostics-only read of an already-failed response
    return "<unreadable body>";
  }
}

/**
 * Run the SIWE handshake through the injected wallet and persist the verified
 * session. Resolves the API key on success; null when no provider is injected
 * or it exposes no account (both mean "SIWE is not available here — fall
 * through to the other sign-in paths"). Throws on a real handshake failure
 * (user rejection, server error) so the caller can surface it.
 */
export async function siweLoginWithInjectedWallet(
  cloudApiBase: string,
): Promise<string | null> {
  const provider = getInjectedEthereumProvider();
  if (!provider) return null;

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as unknown;
  const rawAddress =
    Array.isArray(accounts) && typeof accounts[0] === "string"
      ? accounts[0]
      : null;
  if (!rawAddress) return null;
  // The server-side SIWE parser requires the EIP-55 checksummed form; real
  // wallets often return lowercase. viem is loaded lazily — sign-in is a
  // user-triggered path, the checksum helper must not ride the boot bundle.
  const { getAddress } = await import("viem");
  const address = getAddress(rawAddress);

  const base = cloudApiBase.replace(/\/+$/, "");
  const nonceRes = await fetch(`${base}/api/auth/siwe/nonce`, {
    headers: { accept: "application/json" },
  });
  if (!nonceRes.ok) {
    throw new Error(
      `Eliza Cloud SIWE nonce request failed: ${nonceRes.status} ${await readBody(nonceRes)}`,
    );
  }
  const nonce: unknown = await nonceRes.json();
  if (!isNonceResponse(nonce)) {
    throw new Error("Eliza Cloud SIWE nonce response was malformed.");
  }

  const message = buildSiweMessage({
    domain: nonce.domain,
    address,
    ...(nonce.statement ? { statement: nonce.statement } : {}),
    uri: nonce.uri,
    version: nonce.version || "1",
    chainId: nonce.chainId || 1,
    nonce: nonce.nonce,
    issuedAt: new Date().toISOString(),
  });

  const signature = (await provider.request({
    method: "personal_sign",
    params: [utf8ToHex(message), address],
  })) as unknown;
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    throw new Error("The wallet returned an invalid SIWE signature.");
  }

  const verifyRes = await fetch(`${base}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Eliza Cloud SIWE verify failed: ${verifyRes.status} ${await readBody(verifyRes)}`,
    );
  }
  const verified = (await verifyRes.json()) as { apiKey?: unknown };
  if (typeof verified.apiKey !== "string" || !verified.apiKey) {
    throw new Error("Eliza Cloud SIWE verify returned no API key.");
  }

  writeStoredStewardToken(verified.apiKey);
  logger.info(
    `[CloudSiweLogin] SIWE login verified for ${address.slice(0, 6)}…${address.slice(-4)}`,
  );
  return verified.apiKey;
}
