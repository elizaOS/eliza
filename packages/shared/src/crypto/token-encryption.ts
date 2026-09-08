/**
 * Encrypts connector tokens at rest for Node.js hosts using the shared AES-256-GCM envelope.
 *
 * Connector tokens are encrypted at rest with AES-256-GCM using a symmetric
 * key sourced from one of:
 *
 *   1. `ELIZA_TOKEN_ENCRYPTION_KEY` env var (32 raw bytes, base64- or
 *      hex-encoded). Preferred — operators who manage their own secret
 *      management can inject the key directly.
 *   2. `<credentials-dir>/.encryption-key` file (mode 0600). Generated lazily
 *      the first time we need to write a token and no env var is configured.
 *      The agent reuses this key on subsequent boots.
 *
 * The on-disk format is intentionally minimal: encrypted blobs are JSON
 * objects with a top-level `__enc` discriminator.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";

const KEY_ENV_VAR = "ELIZA_TOKEN_ENCRYPTION_KEY";
const KEY_FILENAME = ".encryption-key";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const AUTH_TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;
const ENVELOPE_DISCRIMINATOR = "__enc" as const;

export interface EncryptedTokenEnvelope {
  readonly [ENVELOPE_DISCRIMINATOR]: "aes-256-gcm";
  readonly v: typeof ENVELOPE_VERSION;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

function decodeKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  // Hex first (deterministic length check).
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    return Buffer.from(trimmed, "hex");
  }
  // Otherwise assume base64 / base64url.
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length === KEY_BYTES) {
    return buf;
  }
  throw new Error(
    `${KEY_ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (got ${buf.length})`,
  );
}

function loadOrCreateKeyFile(credentialsDir: string): Buffer {
  const filePath = path.join(credentialsDir, KEY_FILENAME);
  try {
    return decodeKeyMaterial(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    // error-policy:J3 only an absent key permits creation; invalid existing
    // material must never be replaced with a key that cannot decrypt tokens.
    if (
      !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
    ) {
      throw new ElizaError(
        "Unable to read the persisted connector encryption key",
        {
          code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE",
          cause,
          context: { credentialsDir },
        },
      );
    }
  }
  try {
    return publishKeyFile(credentialsDir, filePath);
  } catch (cause) {
    // error-policy:J2 retain the filesystem failure and identify the key store.
    throw new ElizaError("Unable to publish the connector encryption key", {
      code: "TOKEN_ENCRYPTION_KEY_UNAVAILABLE",
      cause,
      context: { credentialsDir },
    });
  }
}

function publishKeyFile(credentialsDir: string, filePath: string): Buffer {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(KEY_BYTES);
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, key.toString("base64"), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      // Publish a complete key atomically without replacing another writer's
      // winner. Opening the final path with wx exposes a partially written key;
      // renaming over it can strand tokens already encrypted by another host.
      fs.linkSync(temporaryPath, filePath);
      return key;
    } catch (cause) {
      // error-policy:J3 a publication collision means another complete key won.
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "EEXIST")
      ) {
        throw cause;
      }
      return decodeKeyMaterial(fs.readFileSync(filePath, "utf8"));
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * Resolve the symmetric key for token encryption.
 *
 * Resolution order: env var (`ELIZA_TOKEN_ENCRYPTION_KEY`) → file at
 * `<credentialsDir>/.encryption-key`. The file is created (with mode 0600)
 * lazily on first call so existing deployments keep working without an env
 * var.
 */
export function resolveTokenEncryptionKey(
  credentialsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const fromEnv = env[KEY_ENV_VAR]?.trim();
  if (fromEnv) {
    return decodeKeyMaterial(fromEnv);
  }
  return loadOrCreateKeyFile(credentialsDir);
}

export function encryptTokenPayload(
  plaintextJson: string,
  key: Buffer,
): EncryptedTokenEnvelope {
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Token encryption key must be ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextJson, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("AES-GCM auth tag had unexpected length");
  }
  return {
    [ENVELOPE_DISCRIMINATOR]: "aes-256-gcm",
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

export function decryptTokenEnvelope(
  envelope: EncryptedTokenEnvelope,
  key: Buffer,
): string {
  if (envelope[ENVELOPE_DISCRIMINATOR] !== "aes-256-gcm") {
    throw new Error("Unsupported token envelope algorithm");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported token envelope version: ${envelope.v}`);
  }
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Returns true when the parsed JSON value looks like an encrypted envelope.
 */
export function isEncryptedTokenEnvelope(
  value: unknown,
): value is EncryptedTokenEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[ENVELOPE_DISCRIMINATOR] === "aes-256-gcm"
  );
}
