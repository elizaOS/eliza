/**
 * JWKS (JSON Web Key Set) Management
 *
 * Handles key pair storage and JWKS generation for internal service authentication.
 * Supports key rotation by allowing multiple active keys identified by "kid".
 */

import { exportJWK, importPKCS8, importSPKI, type JWK, type CryptoKey as JoseCryptoKey } from "jose";

/**
 * Environment variables for JWT signing keys.
 * JWT_SIGNING_PRIVATE_KEY: Base64-encoded PKCS#8 private key (PEM format without headers)
 * JWT_SIGNING_PUBLIC_KEY: Base64-encoded SPKI public key (PEM format without headers)
 * JWT_SIGNING_KEY_ID: Key identifier for JWKS rotation (defaults to "primary")
 */
const JWT_SIGNING_PRIVATE_KEY = process.env.JWT_SIGNING_PRIVATE_KEY;
const JWT_SIGNING_PUBLIC_KEY = process.env.JWT_SIGNING_PUBLIC_KEY;
const JWT_SIGNING_KEY_ID = process.env.JWT_SIGNING_KEY_ID ?? "primary";

// Algorithm used for signing - ES256 is recommended for security and performance
const ALGORITHM = "ES256";

// Cached key instances to avoid repeated parsing
let cachedPrivateKey: JoseCryptoKey | null = null;
let cachedPublicKey: JoseCryptoKey | null = null;

// Log configuration issues once at startup
if (!JWT_SIGNING_PRIVATE_KEY && process.env.NODE_ENV !== "test") {
  console.error(
    "[CRITICAL] JWT_SIGNING_PRIVATE_KEY not configured - JWT signing will fail",
  );
}
if (!JWT_SIGNING_PUBLIC_KEY && process.env.NODE_ENV !== "test") {
  console.error(
    "[CRITICAL] JWT_SIGNING_PUBLIC_KEY not configured - JWT verification will fail",
  );
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
export async function getPrivateKey(): Promise<JoseCryptoKey> {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  if (!JWT_SIGNING_PRIVATE_KEY) {
    throw new Error("JWT_SIGNING_PRIVATE_KEY is not configured");
  }

  const pem = decodePemKey(JWT_SIGNING_PRIVATE_KEY, "PRIVATE");
  cachedPrivateKey = await importPKCS8(pem, ALGORITHM);
  return cachedPrivateKey;
}

/**
 * Get the public key for verifying JWTs.
 * Keys are cached after first load.
 */
export async function getPublicKey(): Promise<JoseCryptoKey> {
  if (cachedPublicKey) {
    return cachedPublicKey;
  }

  if (!JWT_SIGNING_PUBLIC_KEY) {
    throw new Error("JWT_SIGNING_PUBLIC_KEY is not configured");
  }

  const pem = decodePemKey(JWT_SIGNING_PUBLIC_KEY, "PUBLIC");
  cachedPublicKey = await importSPKI(pem, ALGORITHM);
  return cachedPublicKey;
}

/**
 * Get the key ID for the current signing key.
 */
export function getKeyId(): string {
  return JWT_SIGNING_KEY_ID;
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
  jwk.kid = JWT_SIGNING_KEY_ID;
  jwk.alg = ALGORITHM;
  jwk.use = "sig"; // Signature use

  return { keys: [jwk] };
}

/**
 * Check if JWKS keys are configured.
 * Returns false if keys are missing (useful for health checks).
 */
export function isJWKSConfigured(): boolean {
  return Boolean(JWT_SIGNING_PRIVATE_KEY && JWT_SIGNING_PUBLIC_KEY);
}
