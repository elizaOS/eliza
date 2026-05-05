/**
 * JWKS (JSON Web Key Set) Management
 *
 * Handles key pair storage and JWKS generation for internal service authentication.
 * Supports key rotation by allowing multiple active keys identified by "kid".
 */

// jose v6 dropped the legacy `KeyLike` alias; `importPKCS8` / `importSPKI`
// now resolve to the global `CryptoKey` type directly, which is available
// in Node 18+ and Cloudflare Workers — everywhere this module runs.
import { exportJWK, importPKCS8, importSPKI, type JWK } from "jose";

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

/**
 * Environment variables for JWT signing keys.
 * JWT_SIGNING_PRIVATE_KEY: Base64-encoded PKCS#8 private key (PEM format without headers)
 * JWT_SIGNING_PUBLIC_KEY: Base64-encoded SPKI public key (PEM format without headers)
 * JWT_SIGNING_KEY_ID: Key identifier for JWKS rotation (defaults to "primary")
 */
// Algorithm used for signing - ES256 is recommended for security and performance
const ALGORITHM = "ES256";

// Cached key instances to avoid repeated parsing (invalidated when env value changes)
let cachedPrivateKey: CryptoKey | null = null;
let cachedPrivateKeySource: string | null = null;
let cachedPublicKey: CryptoKey | null = null;
let cachedPublicKeySource: string | null = null;

function getSigningPrivateKeyEnv(): string | undefined {
  return getCloudAwareEnv().JWT_SIGNING_PRIVATE_KEY;
}

function getSigningPublicKeyEnv(): string | undefined {
  return getCloudAwareEnv().JWT_SIGNING_PUBLIC_KEY;
}

function getSigningKeyIdEnv(): string {
  return getCloudAwareEnv().JWT_SIGNING_KEY_ID ?? "primary";
}

/**
 * Decode a base64-encoded PEM key (without headers) back to PEM format.
 */
function decodePemKey(base64Key: string, type: "PRIVATE" | "PUBLIC"): string {
  const decoded = Buffer.from(base64Key, "base64").toString("utf8");
  // Check if it's already in PEM format
  if (decoded.includes("-----BEGIN")) {
    return decoded;
  }
  // Otherwise, wrap it in PEM headers
  const keyType = type === "PRIVATE" ? "PRIVATE KEY" : "PUBLIC KEY";
  return `-----BEGIN ${keyType}-----\n${base64Key}\n-----END ${keyType}-----`;
}

/**
 * Get the private key for signing JWTs.
 * Keys are cached after first load.
 */
export async function getPrivateKey(): Promise<CryptoKey> {
  const privateKey = getSigningPrivateKeyEnv();
  if (!privateKey) {
    throw new Error("JWT_SIGNING_PRIVATE_KEY is not configured");
  }

  if (cachedPrivateKey && cachedPrivateKeySource === privateKey) {
    return cachedPrivateKey;
  }

  const pem = decodePemKey(privateKey, "PRIVATE");
  cachedPrivateKey = await importPKCS8(pem, ALGORITHM);
  cachedPrivateKeySource = privateKey;
  return cachedPrivateKey;
}

/**
 * Get the public key for verifying JWTs.
 * Keys are cached after first load.
 */
export async function getPublicKey(): Promise<CryptoKey> {
  const publicKey = getSigningPublicKeyEnv();
  if (!publicKey) {
    throw new Error("JWT_SIGNING_PUBLIC_KEY is not configured");
  }

  if (cachedPublicKey && cachedPublicKeySource === publicKey) {
    return cachedPublicKey;
  }

  const pem = decodePemKey(publicKey, "PUBLIC");
  cachedPublicKey = await importSPKI(pem, ALGORITHM, { extractable: true });
  cachedPublicKeySource = publicKey;
  return cachedPublicKey;
}

/**
 * Get the key ID for the current signing key.
 */
export function getKeyId(): string {
  return getSigningKeyIdEnv();
}

/**
 * Get the algorithm used for signing.
 */
export function getAlgorithm(): string {
  return ALGORITHM;
}

/**
 * Generate the JWKS (JSON Web Key Set) containing public keys for JWT verification.
 * This is exposed at /.well-known/jwks.json
 */
export async function getJWKS(): Promise<{ keys: JWK[] }> {
  const publicKey = await getPublicKey();
  const jwk = await exportJWK(publicKey);

  // Add required metadata
  jwk.kid = getSigningKeyIdEnv();
  jwk.alg = ALGORITHM;
  jwk.use = "sig"; // Signature use

  return { keys: [jwk] };
}

/**
 * Check if JWKS keys are configured.
 * Returns false if keys are missing (useful for health checks).
 */
export function isJWKSConfigured(): boolean {
  return Boolean(getSigningPrivateKeyEnv() && getSigningPublicKeyEnv());
}
