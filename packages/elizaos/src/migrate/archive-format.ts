/**
 * Self-contained `.eliza-agent` archive writer (V1 binary format).
 *
 * Implements the SAME on-disk format as `@elizaos/agent`'s exportAgent
 * (gzip → PBKDF2-SHA256 → AES-256-GCM → packed file), using ONLY node built-ins
 * so the CLI does not depend on the agent runtime. The format is the V1 spec:
 *
 *   ELIZA_AGENT_V1\n   (15 bytes magic)
 *   iterations         (4 bytes uint32 BE)
 *   salt               (32 bytes)
 *   iv                 (12 bytes - AES-256-GCM nonce)
 *   tag                (16 bytes - AES-GCM auth tag)
 *   ciphertext         (gzip-compressed JSON, AES-256-GCM encrypted)
 *
 * Output round-trips through `importAgent(runtime, buffer, password)`. If the
 * upstream format ever bumps past V1, update the constants here in lockstep
 * (they are intentionally explicit + documented for that reason).
 */

import * as crypto from "node:crypto";
import { gzipSync } from "node:zlib";

const MAGIC_HEADER = "ELIZA_AGENT_V1\n";
const MAGIC_BYTES = Buffer.from(MAGIC_HEADER, "utf-8"); // 15 bytes
const PBKDF2_ITERATIONS = 600_000; // OWASP 2024 recommendation for SHA-256
const SALT_LEN = 32;
const IV_LEN = 12; // AES-256-GCM standard nonce
const KEY_LEN = 32; // AES-256
const MIN_PASSWORD_LENGTH = 4;

function deriveKey(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, KEY_LEN, "sha256");
}

/**
 * Encrypt + pack an already-serialized payload object into a `.eliza-agent`
 * archive buffer.
 *
 * @param payload  A PayloadSchema-conformant object (will be JSON-serialized).
 * @param password Min length enforced (matches importAgent's expectation).
 */
export function buildElizaAgentArchive(
  payload: unknown,
  password: string,
): Buffer {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `A password of at least ${MIN_PASSWORD_LENGTH} characters is required to encrypt the export.`,
    );
  }

  const jsonString = JSON.stringify(payload);
  const compressed = gzipSync(Buffer.from(jsonString, "utf-8"));

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt, PBKDF2_ITERATIONS);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const iterBuf = Buffer.alloc(4);
  iterBuf.writeUInt32BE(PBKDF2_ITERATIONS, 0);

  return Buffer.concat([MAGIC_BYTES, iterBuf, salt, iv, tag, ciphertext]);
}
