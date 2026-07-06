/**
 * Ed25519 key handling for certification signing. Everything here is
 * node:crypto — no external crypto dependencies, because this code must run
 * identically in minimal CI containers and on certifier laptops, and because
 * the CI gate's trust chain must be auditable end to end.
 *
 * Key custody rules this module enforces by construction: the private key is
 * only ever accepted through `ELIZA_CERT_SIGNING_KEY` (PEM, or base64-wrapped
 * PEM for env-var transport) or an explicit key file the caller already owns;
 * it is returned as a `KeyObject` and never re-exported, written to disk, or
 * echoed into an error message. Public keys are identified by a fingerprint —
 * the first 16 hex chars of sha256 over the SPKI DER — which is embedded in
 * every signature envelope so verification can distinguish `wrong-key` (a
 * different keypair signed this) from `bad-signature` (the payload was
 * altered).
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import { EvidenceError } from "../errors.ts";

/** Environment variable carrying the signing key (PEM or base64-wrapped PEM). */
export const SIGNING_KEY_ENV_VAR = "ELIZA_CERT_SIGNING_KEY";

/** Result of {@link generateCertificationKeypair}. */
export interface GeneratedKeypair {
  /** SPKI PEM — the half that gets committed to `.github/certification/`. */
  publicKeyPem: string;
  /** PKCS8 PEM — never write this to disk; store as a secret. */
  privateKeyPem: string;
  fingerprint: string;
}

function assertEd25519(key: KeyObject, role: "public" | "private"): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new EvidenceError(
      `certification ${role} key must be ed25519, got: ${key.asymmetricKeyType ?? "unknown"}`,
      { code: "CERT_KEY_INVALID", context: { role } },
    );
  }
}

/** Parse an SPKI PEM into a validated Ed25519 public `KeyObject`. */
export function toPublicKey(publicKeyPem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — an unparseable public key is a
    // trust-chain configuration error the caller must see, not a soft failure.
    throw new EvidenceError("certification public key is not valid PEM", {
      code: "CERT_KEY_INVALID",
      cause: error,
      context: { role: "public" },
    });
  }
  assertEd25519(key, "public");
  return key;
}

/**
 * Fingerprint a public key: first 16 hex chars of sha256(SPKI DER). Stable
 * across PEM formatting differences because it hashes the DER encoding.
 */
export function fingerprintPublicKey(publicKeyPem: string | KeyObject): string {
  const key =
    typeof publicKeyPem === "string" ? toPublicKey(publicKeyPem) : publicKeyPem;
  assertEd25519(key, "public");
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Generate a fresh Ed25519 certification keypair with its fingerprint. */
export function generateCertificationKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  return {
    publicKeyPem,
    privateKeyPem,
    fingerprint: fingerprintPublicKey(publicKey),
  };
}

/** Parse PEM text (private half) into a validated Ed25519 `KeyObject`. */
export function toPrivateKey(privateKeyPem: string | KeyObject): KeyObject {
  if (typeof privateKeyPem !== "string") {
    assertEd25519(privateKeyPem, "private");
    return privateKeyPem;
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — the message deliberately
    // carries no key material; only the classification survives.
    throw new EvidenceError("certification signing key is not valid PEM", {
      code: "CERT_KEY_INVALID",
      cause: error,
      context: { role: "private" },
    });
  }
  assertEd25519(key, "private");
  return key;
}

/** Derive the SPKI PEM public half from a private key. */
export function derivePublicKeyPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
}

/**
 * Normalize signing-key ingress text: raw PEM passes through; anything else
 * must be base64 that decodes to PEM (the recommended transport for env vars,
 * where literal newlines do not survive every shell/CI boundary).
 */
function decodeKeyMaterial(raw: string, sourceLabel: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  throw new EvidenceError(
    `${sourceLabel} is neither PEM nor base64-wrapped PEM`,
    { code: "CERT_KEY_INVALID", context: { source: sourceLabel } },
  );
}

/** Options for {@link resolveSigningKey}. */
export interface ResolveSigningKeyOptions {
  /** Environment map to read `ELIZA_CERT_SIGNING_KEY` from (injectable for tests). */
  env: Record<string, string | undefined>;
  /** Explicit key file; takes precedence over the environment variable. */
  keyFile?: string;
}

/**
 * Resolve the signing key from `--key-file` or `ELIZA_CERT_SIGNING_KEY`.
 * Missing key is a hard, actionable error — signing must never fall back to
 * an ambient or generated key.
 */
export function resolveSigningKey(
  options: ResolveSigningKeyOptions,
): KeyObject {
  if (options.keyFile !== undefined) {
    let raw: string;
    try {
      raw = fs.readFileSync(options.keyFile, "utf8");
    } catch (error) {
      // error-policy:J2 context-adding rethrow — a missing key file must not
      // silently defer to the env var the caller did not intend to use.
      throw new EvidenceError(
        `signing key file unreadable: ${options.keyFile}`,
        {
          code: "CERT_KEY_UNREADABLE",
          cause: error,
          context: { keyFile: options.keyFile },
        },
      );
    }
    return toPrivateKey(decodeKeyMaterial(raw, `key file ${options.keyFile}`));
  }
  const fromEnv = options.env[SIGNING_KEY_ENV_VAR];
  if (fromEnv === undefined || fromEnv.trim().length === 0) {
    throw new EvidenceError(
      `no signing key: set ${SIGNING_KEY_ENV_VAR} (PEM or base64-wrapped PEM) or pass --key-file`,
      { code: "CERT_KEY_MISSING" },
    );
  }
  return toPrivateKey(decodeKeyMaterial(fromEnv, SIGNING_KEY_ENV_VAR));
}
