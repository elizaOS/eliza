/** Validates deployment salts before deriving persisted wallet encryption keys. */
import { Buffer } from "node:buffer";

export const KDF_SALT_MIN_BYTES = 16;

const KDF_SALT_REQUIREMENT =
  "must be an even-length hexadecimal string of at least 32 characters (16 bytes). Generate with: openssl rand -hex 32";

/**
 * Decode a deployment KDF salt without Node's permissive partial-hex parsing.
 *
 * `Buffer.from(value, "hex")` silently stops at an invalid nibble. Validate the
 * complete string first so operator preflight and the production KeyStore use
 * exactly the same fail-closed contract and derive from exactly the bytes the
 * operator supplied.
 */
export function decodeKdfSalt(
  value: string,
  variableName = "STEWARD_KDF_SALT",
) {
  if (
    typeof value !== "string" ||
    value.length < KDF_SALT_MIN_BYTES * 2 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(value)
  ) {
    throw new Error(`${variableName} ${KDF_SALT_REQUIREMENT}`);
  }

  return Buffer.from(value, "hex");
}
