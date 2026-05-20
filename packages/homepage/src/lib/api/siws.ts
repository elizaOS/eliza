/**
 * Sign-In-With-Solana client for the homepage.
 *
 * Wraps the Cloud endpoints at:
 *   GET  /api/auth/siws/nonce
 *   POST /api/auth/siws/verify
 *
 * Uses an injected Phantom-style wallet at window.solana for real sign-ins.
 * Falls back to a synchronous test signer at window.__siwsTestSigner so the
 * Playwright e2e suite can exercise the flow without a real wallet.
 */
import { getElizacloudUrl } from "@/lib/api/client";

const BS58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function bs58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let s = "";
  while (n > 0n) {
    s = BS58_ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) s = `${BS58_ALPHABET[0]}${s}`;
    else break;
  }
  return s;
}

interface NonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string;
  version: string;
  statement: string;
}

export interface SiwsVerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: { id: string; wallet_address: string; organization_id: string };
  organization: { id: string; name: string; slug: string } | null;
}

interface PhantomWallet {
  publicKey?: { toString(): string };
  connect: () => Promise<{ publicKey: { toString(): string } } | void>;
  signMessage: (
    message: Uint8Array,
    encoding?: "utf8",
  ) => Promise<{ signature: Uint8Array }>;
}

export interface SiwsTestSigner {
  publicKey: string;
  sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

declare global {
  interface Window {
    solana?: PhantomWallet;
    phantom?: { solana?: PhantomWallet };
    __siwsTestSigner?: SiwsTestSigner;
  }
}

function detectPhantom(): PhantomWallet | null {
  if (typeof window === "undefined") return null;
  const direct = window.solana;
  if (direct) return direct;
  const nested = window.phantom?.solana;
  if (nested) return nested;
  return null;
}

function buildSiwsMessage(p: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return `${p.domain} wants you to sign in with your Solana account:
${p.address}

${p.statement}

URI: ${p.uri}
Version: ${p.version}
Chain ID: ${p.chainId}
Nonce: ${p.nonce}
Issued At: ${p.issuedAt}`;
}

export async function signInWithSolana(): Promise<SiwsVerifyResponse> {
  const base = getElizacloudUrl();
  const test = typeof window !== "undefined" ? window.__siwsTestSigner : null;

  let address: string;
  let signBytes: (msg: Uint8Array) => Promise<Uint8Array>;
  if (test) {
    address = test.publicKey;
    signBytes = async (msg) => {
      const out = await test.sign(msg);
      return out instanceof Uint8Array ? out : new Uint8Array(out);
    };
  } else {
    const wallet = detectPhantom();
    if (!wallet) {
      throw new Error(
        "No Solana wallet detected. Install Phantom from phantom.app to continue.",
      );
    }
    if (!wallet.publicKey) {
      const result = await wallet.connect();
      if (result && "publicKey" in result && result.publicKey) {
        address = result.publicKey.toString();
      } else if (wallet.publicKey) {
        address = (wallet.publicKey as { toString(): string }).toString();
      } else {
        throw new Error("Wallet connection rejected");
      }
    } else {
      address = wallet.publicKey.toString();
    }
    signBytes = async (msg) => {
      const result = await wallet.signMessage(msg, "utf8");
      return result.signature;
    };
  }

  const nonceRes = await fetch(`${base}/api/auth/siws/nonce?chainId=solana:mainnet`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!nonceRes.ok) {
    throw new Error(`SIWS nonce request failed: ${nonceRes.status}`);
  }
  const nonce = (await nonceRes.json()) as NonceResponse;

  const message = buildSiwsMessage({
    domain: nonce.domain,
    address,
    statement: nonce.statement,
    uri: nonce.uri,
    version: nonce.version,
    chainId: nonce.chainId,
    nonce: nonce.nonce,
    issuedAt: new Date().toISOString(),
  });

  const signatureBytes = await signBytes(new TextEncoder().encode(message));

  const verifyRes = await fetch(`${base}/api/auth/siws/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      message,
      signature: bs58Encode(signatureBytes),
    }),
  });
  if (!verifyRes.ok) {
    const detail = await verifyRes.text().catch(() => "");
    throw new Error(`SIWS verification failed (${verifyRes.status}): ${detail}`);
  }
  return (await verifyRes.json()) as SiwsVerifyResponse;
}
