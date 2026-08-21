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
import { getElizacloudUrl } from "./client";

const SIWS_FETCH_TIMEOUT_MS = 15_000;
const SIWS_RESPONSE_MAX_BYTES = 64 * 1024;
const SIWS_FIELD_MAX_BYTES = 2_048;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoundedString(
  value: unknown,
  max = SIWS_FIELD_MAX_BYTES,
): value is string {
  return (
    isNonEmptyString(value) && new TextEncoder().encode(value).byteLength <= max
  );
}

function containsLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function isOrganization(
  value: unknown,
): value is { id: string; name: string; slug: string } {
  return (
    isRecord(value) &&
    isBoundedControlFreeString(value.id, 256) &&
    isBoundedControlFreeString(value.name, 256) &&
    isBoundedControlFreeString(value.slug, 256)
  );
}

function isBoundedControlFreeString(
  value: unknown,
  max = SIWS_FIELD_MAX_BYTES,
): value is string {
  return isBoundedString(value, max) && !containsControlCharacter(value);
}

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", {
    configurable: true,
    value: cause,
  });
  return error;
}

/**
 * Relying-party origins the wallet may be asked to sign for. The Cloud API
 * issues its own `NEXT_PUBLIC_APP_URL` origin (`https://cloud.eliza.app` in
 * production, `https://cloud-staging.eliza.app` on staging) as the nonce
 * `uri`, so those canonical origins are always trusted; the page's own origin
 * is included for e2e doubles and preview deployments that mirror it.
 */
function expectedRelyingPartyOrigins(): ReadonlySet<string> {
  const origins = new Set([
    "https://cloud.eliza.app",
    "https://cloud-staging.eliza.app",
  ]);
  if (typeof window !== "undefined" && window.location) {
    origins.add(window.location.origin);
  }
  return origins;
}

function parseNonceResponse(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
): NonceResponse {
  if (
    !isRecord(value) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.nonce) ||
    !isBoundedString(value.domain, 253) ||
    containsLineBreak(value.domain) ||
    !isBoundedString(value.uri) ||
    containsLineBreak(value.uri) ||
    value.chainId !== "solana:mainnet" ||
    value.version !== "1" ||
    typeof value.statement !== "string" ||
    new TextEncoder().encode(value.statement).byteLength > 512 ||
    containsLineBreak(value.statement)
  ) {
    throw new Error("SIWS nonce response has an invalid shape");
  }
  let relyingParty: URL;
  try {
    relyingParty = new URL(value.uri);
  } catch {
    // error-policy:J3 malformed relying-party URIs are rejected before wallet signing.
    throw new Error("SIWS nonce response has an invalid shape");
  }
  if (
    relyingParty.host !== value.domain ||
    relyingParty.username !== "" ||
    relyingParty.password !== "" ||
    relyingParty.hash !== "" ||
    !(
      (relyingParty.protocol === "https:" &&
        allowedOrigins.has(relyingParty.origin)) ||
      (relyingParty.protocol === "http:" &&
        LOOPBACK_HOSTS.has(relyingParty.hostname))
    )
  ) {
    throw new Error("SIWS nonce response has an invalid shape");
  }
  return {
    nonce: value.nonce,
    domain: value.domain,
    uri: value.uri,
    chainId: value.chainId,
    version: value.version,
    statement: value.statement,
  };
}

function parseVerifyResponse(value: unknown): SiwsVerifyResponse {
  if (
    !isRecord(value) ||
    !isBoundedString(value.apiKey, 8 * 1024) ||
    containsControlCharacter(value.apiKey) ||
    typeof value.address !== "string" ||
    !SOLANA_ADDRESS_RE.test(value.address) ||
    typeof value.isNewAccount !== "boolean" ||
    !isRecord(value.user) ||
    !isBoundedControlFreeString(value.user.id, 256) ||
    typeof value.user.wallet_address !== "string" ||
    !SOLANA_ADDRESS_RE.test(value.user.wallet_address) ||
    !isBoundedControlFreeString(value.user.organization_id, 256) ||
    !isOrganization(value.organization) ||
    value.organization.id !== value.user.organization_id
  ) {
    throw new Error("SIWS verification response has an invalid shape");
  }
  return {
    apiKey: value.apiKey,
    address: value.address,
    isNewAccount: value.isNewAccount,
    user: {
      id: value.user.id,
      wallet_address: value.user.wallet_address,
      organization_id: value.user.organization_id,
    },
    organization: {
      id: value.organization.id,
      name: value.organization.name,
      slug: value.organization.slug,
    },
  };
}

function cancelResponseBody(response: Response, reason: string): void {
  if (!response.body || response.bodyUsed) return;
  try {
    void Promise.resolve(response.body.cancel(reason)).catch(() => {
      // error-policy:J6 response teardown must not mask the boundary failure.
    });
  } catch {
    // error-policy:J6 a custom response stream may throw during teardown.
  }
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!(contentType === "application/json" || contentType?.endsWith("+json"))) {
    cancelResponseBody(response, "SIWS response media type rejected");
    throw new Error("SIWS response is not JSON");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = /^\d+$/.test(declaredLength)
      ? Number(declaredLength)
      : Number.NaN;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > SIWS_RESPONSE_MAX_BYTES
    ) {
      cancelResponseBody(response, "SIWS response length rejected");
      throw new Error("SIWS response is too large");
    }
  }
  if (!response.body) throw new Error("SIWS response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let fullyRead = false;
  try {
    while (true) {
      const { done, value } = await waitForAbort(reader.read(), signal);
      if (done) {
        fullyRead = true;
        break;
      }
      total += value.byteLength;
      if (total > SIWS_RESPONSE_MAX_BYTES) {
        throw new Error("SIWS response is too large");
      }
      chunks.push(value);
    }
  } finally {
    if (fullyRead) {
      reader.releaseLock();
    } else {
      try {
        const cancellation = reader.cancel(
          signal.aborted ? signal.reason : "SIWS response consumption stopped",
        );
        void Promise.resolve(cancellation)
          .catch(() => {
            // error-policy:J6 response teardown must not mask the typed boundary failure.
          })
          .finally(() => {
            try {
              reader.releaseLock();
            } catch {
              // error-policy:J6 a still-pending custom stream may retain its lock off-path.
            }
          });
      } catch {
        // error-policy:J6 synchronous response cancellation is teardown-only.
        try {
          reader.releaseLock();
        } catch {
          // error-policy:J6 a pending read may keep the custom stream locked.
        }
      }
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

async function requestSiwsJson(
  url: string,
  operation: "nonce" | "verification",
  init: RequestInit,
): Promise<unknown> {
  const signal = AbortSignal.timeout(SIWS_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal });
  } catch (cause) {
    // error-policy:J2 Translate browser/network failures without exposing transport details.
    const suffix = signal.aborted ? " timed out" : " failed";
    throw errorWithCause(`SIWS ${operation} request${suffix}`, cause);
  }
  if (response.redirected || (response.url !== "" && response.url !== url)) {
    cancelResponseBody(response, "SIWS redirected response rejected");
    throw new Error(`SIWS ${operation} request failed`);
  }
  if (!response.ok) {
    cancelResponseBody(response, "SIWS error response discarded");
    throw new Error(`SIWS ${operation} request failed (${response.status})`);
  }
  try {
    return await readBoundedJson(response, signal);
  } catch (cause) {
    // error-policy:J2 Keep body and decoding details out of the UI error path.
    const suffix = signal.aborted
      ? " timed out"
      : " returned an invalid response";
    throw errorWithCause(`SIWS ${operation} request${suffix}`, cause);
  }
}

export interface SiwsVerifyResponse {
  apiKey: string;
  address: string;
  isNewAccount: boolean;
  user: { id: string; wallet_address: string; organization_id: string };
  organization: { id: string; name: string; slug: string };
}

interface PhantomWallet {
  publicKey?: { toString(): string };
  connect: () => Promise<{ publicKey: { toString(): string } } | undefined>;
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

  if (!SOLANA_ADDRESS_RE.test(address)) {
    throw new Error("Wallet returned an invalid Solana address");
  }

  const nonceValue = await requestSiwsJson(
    `${base}/api/auth/siws/nonce?chainId=solana:mainnet`,
    "nonce",
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  const nonce = parseNonceResponse(nonceValue, expectedRelyingPartyOrigins());

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
  if (signatureBytes.byteLength !== 64) {
    throw new Error("Wallet returned an invalid Solana signature");
  }

  const verifyValue = await requestSiwsJson(
    `${base}/api/auth/siws/verify`,
    "verification",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        message,
        signature: bs58Encode(signatureBytes),
      }),
    },
  );
  const verified = parseVerifyResponse(verifyValue);
  if (
    verified.address !== address ||
    verified.user.wallet_address !== address
  ) {
    throw new Error("SIWS verification response does not match the signer");
  }
  return verified;
}
