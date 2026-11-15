/**
 * Per-session authentication material for the loopback sub-agent bridge
 * (parent-context, memory, active-workspaces, skills and credentials).
 * The bearer is injected into the child process once; only its hash is kept in
 * durable ACP session metadata.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

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

/** The bearer a child sends: `X-Eliza-Session-Token`, else `Authorization: Bearer`. */
export function readSessionBridgeToken(req: IncomingMessage): string | null {
  const header = req.headers["x-eliza-session-token"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

/**
 * True when the request carries the bearer minted for this session. The bridge
 * routes are public to the server's central auth gate, so this check (with the
 * loopback check) is their whole authentication.
 */
export function verifySessionBridgeToken(
  req: IncomingMessage,
  sessionMetadata: Record<string, unknown> | undefined,
): boolean {
  const token = readSessionBridgeToken(req);
  return (
    token !== null &&
    matchesCredentialBridgeToken(
      token,
      sessionMetadata?.[CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA],
    )
  );
}

export function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}
