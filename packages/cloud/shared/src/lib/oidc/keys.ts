/**
 * Signing key ring for OIDC ID tokens and access tokens.
 *
 * A DEDICATED ring, not the `JWT_SIGNING_*` pair: that ES256 key already signs
 * internal-service JWTs (`aud: eliza-cloud-internal`) and voice-session tokens
 * (`aud: voice-session`) under one `kid`, and adding a third, externally
 * verified token class would leave audience checking as the only thing
 * preventing cross-acceptance.
 *
 * `OIDC_SIGNING_JWKS` holds a JSON array of PRIVATE JWKs (optionally base64
 * wrapped, because Worker secrets travel badly with newlines). Element 0
 * signs; every element is published. That ordering is the first
 * overlap-capable rotation in this codebase — the existing `getJWKS()` and
 * `getAgentTokenJWKS()` each publish exactly one key, so rotating either
 * invalidates every in-flight token at once. It matters here because jose's
 * `createRemoteJWKSet` (what Merge Steward and most RPs use) only refetches on
 * an UNKNOWN `kid`: publish new-and-old together, wait out the token TTL plus
 * the JWKS `max-age`, then drop the tail.
 *
 * A malformed entry THROWS rather than being skipped — silently signing with
 * the next key would strand every token already issued under the intended one.
 */

import { calculateJwkThumbprint, importJWK, type JWK } from "jose";

import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export interface OidcSigner {
  key: CryptoKey;
  kid: string;
  alg: string;
}

interface RingEntry {
  kid: string;
  alg: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

interface ParsedRing {
  entries: RingEntry[];
}

let cachedRing: ParsedRing | null = null;
let cachedRingSource: string | null = null;
const importedKeys = new Map<string, CryptoKey>();

/** Private JWK members that must never reach the published key set. */
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

function readSource(): string | undefined {
  const raw = getCloudAwareEnv().OIDC_SIGNING_JWKS;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function isOidcSigningConfigured(): boolean {
  return Boolean(readSource());
}

function decodeSource(source: string): unknown {
  const direct = source.startsWith("[") || source.startsWith("{") ? source : null;
  const text = direct ?? Buffer.from(source, "base64").toString("utf8");
  return JSON.parse(text) as unknown;
}

/** Signature algorithms an RSA key may carry; the first is the default. */
const RSA_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512"] as const;
/** Each EC curve signs under exactly one JWS algorithm. */
const EC_CURVE_ALGORITHMS: Record<string, string> = {
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

/**
 * The JWS signature algorithms this key can actually be used with, most
 * preferred first, or an empty list for a key type this provider cannot sign
 * with. `alg` on a JWK is operator-supplied and reaches relying parties through
 * `id_token_signing_alg_values_supported`, so it is checked against the key
 * rather than trusted: `none`, a MAC algorithm, an encryption algorithm, and a
 * curve/algorithm mismatch all have to fail here, at load, instead of being
 * advertised as something this provider will sign an ID token with.
 */
function signatureAlgorithms(jwk: JWK): string[] {
  if (jwk.kty === "RSA") return [...RSA_ALGORITHMS];
  if (jwk.kty === "EC") {
    const alg = typeof jwk.crv === "string" ? EC_CURVE_ALGORITHMS[jwk.crv] : undefined;
    return alg ? [alg] : [];
  }
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return ["EdDSA"];
  return [];
}

/** The declared `alg`, or the key's default when the JWK omits one. */
function resolveAlgorithm(jwk: JWK, index: number): string {
  const supported = signatureAlgorithms(jwk);
  if (supported.length === 0) {
    throw new Error(
      `OIDC_SIGNING_JWKS[${index}]: cannot sign with kty=${String(jwk.kty)} crv=${String(jwk.crv)}`,
    );
  }
  if (typeof jwk.alg !== "string" || !jwk.alg) return supported[0];
  if (!supported.includes(jwk.alg)) {
    throw new Error(
      `OIDC_SIGNING_JWKS[${index}]: alg "${jwk.alg}" cannot sign with this key (expected one of ${supported.join(", ")})`,
    );
  }
  return jwk.alg;
}

function toPublicJwk(jwk: JWK): JWK {
  const pub: JWK = { ...jwk };
  for (const member of PRIVATE_JWK_MEMBERS) {
    delete (pub as Record<string, unknown>)[member];
  }
  return pub;
}

async function parseRing(source: string): Promise<ParsedRing> {
  let decoded: unknown;
  try {
    decoded = decodeSource(source);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — the operator needs to know the
    // env var is unparseable, and the raw value must never appear in the log.
    throw new Error("OIDC_SIGNING_JWKS is not valid JSON (or base64-wrapped JSON)", {
      cause: error,
    });
  }

  const list = Array.isArray(decoded) ? decoded : [decoded];
  if (list.length === 0) {
    throw new Error("OIDC_SIGNING_JWKS must contain at least one private JWK");
  }

  const entries: RingEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    if (!raw || typeof raw !== "object") {
      throw new Error(`OIDC_SIGNING_JWKS[${index}] is not an object`);
    }
    const jwk = raw as JWK;
    if (jwk.kty === "oct" || typeof (jwk as Record<string, unknown>).k === "string") {
      throw new Error(
        `OIDC_SIGNING_JWKS[${index}] is a symmetric key; ID tokens must be verifiable from the public JWKS`,
      );
    }
    if (typeof jwk.d !== "string") {
      throw new Error(`OIDC_SIGNING_JWKS[${index}] is a public key; a private JWK is required`);
    }
    const alg = resolveAlgorithm(jwk, index);
    const publicJwk = toPublicJwk(jwk);
    const kid =
      typeof jwk.kid === "string" && jwk.kid
        ? jwk.kid
        : (await calculateJwkThumbprint(publicJwk, "sha256")).slice(0, 16);
    if (seen.has(kid)) {
      throw new Error(`OIDC_SIGNING_JWKS contains duplicate kid "${kid}"`);
    }
    seen.add(kid);
    publicJwk.kid = kid;
    publicJwk.alg = alg;
    publicJwk.use = "sig";
    entries.push({ kid, alg, privateJwk: { ...jwk, kid, alg }, publicJwk });
  }
  return { entries };
}

async function getRing(): Promise<ParsedRing> {
  const source = readSource();
  if (!source) {
    throw new Error("OIDC_SIGNING_JWKS is not configured");
  }
  if (cachedRing && cachedRingSource === source) return cachedRing;
  cachedRing = await parseRing(source);
  cachedRingSource = source;
  importedKeys.clear();
  return cachedRing;
}

/**
 * Import one half of a ring entry. Signing and verification are separate cache
 * slots because WebCrypto keys are single-purpose: a private key imported for
 * signing is rejected by `jwtVerify`, and vice versa.
 */
async function importEntry(entry: RingEntry, use: "sign" | "verify"): Promise<CryptoKey> {
  const cacheKey = `${use}:${entry.kid}`;
  const cached = importedKeys.get(cacheKey);
  if (cached) return cached;

  const jwk = use === "sign" ? entry.privateJwk : entry.publicJwk;
  const key = await importJWK(jwk, entry.alg);
  if (!(key instanceof CryptoKey)) {
    throw new Error(`OIDC_SIGNING_JWKS key "${entry.kid}" did not import as a CryptoKey`);
  }
  importedKeys.set(cacheKey, key);
  return key;
}

/** The active signing key — always element 0 of the ring. */
export async function getOidcSigner(): Promise<OidcSigner> {
  const ring = await getRing();
  const entry = ring.entries[0];
  if (!entry) {
    throw new Error("OIDC_SIGNING_JWKS ring is empty");
  }
  return { key: await importEntry(entry, "sign"), kid: entry.kid, alg: entry.alg };
}

/**
 * Resolve a verification key by `kid`. Used by `/userinfo` to check an access
 * token locally, which is why retired keys stay in the ring: a token signed
 * just before a rotation must still verify until it expires.
 */
export async function getOidcVerificationKey(kid: string | undefined): Promise<CryptoKey | null> {
  const ring = await getRing();
  const entry = kid ? ring.entries.find((candidate) => candidate.kid === kid) : ring.entries[0];
  if (!entry) return null;
  return await importEntry(entry, "verify");
}

/** Every published public key, newest first. */
export async function getOidcPublicJwks(): Promise<{ keys: JWK[] }> {
  const ring = await getRing();
  return { keys: ring.entries.map((entry) => ({ ...entry.publicJwk })) };
}

/**
 * Distinct `alg` values, active signer first — the input to
 * `id_token_signing_alg_values_supported`. Each was checked against its key at
 * load, so `none`, a MAC algorithm, and a key/curve mismatch cannot appear.
 */
export async function getOidcSigningAlgorithms(): Promise<string[]> {
  const ring = await getRing();
  return [...new Set(ring.entries.map((entry) => entry.alg))];
}

/** Test-only: drop the memoized ring so a suite can swap `OIDC_SIGNING_JWKS`. */
export function _resetOidcKeyCacheForTests(): void {
  cachedRing = null;
  cachedRingSource = null;
  importedKeys.clear();
}
