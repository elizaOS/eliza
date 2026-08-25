/**
 * Per-session authentication material for the loopback credential bridge.
 * The bearer is injected into the child process once; only its hash is kept in
 * durable ACP session metadata.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CREDENTIAL_BRIDGE_TOKEN_ENV = "ELIZA_CREDENTIAL_BRIDGE_TOKEN";
export const CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA =
  "credentialBridgeTokenHash";

export function createCredentialBridgeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCredentialBridgeToken(token) };
}

export function hashCredentialBridgeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function matchesCredentialBridgeToken(
  token: string,
  expectedHash: unknown,
): boolean {
  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/i.test(expectedHash))
    return false;
  const actual = Buffer.from(hashCredentialBridgeToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
