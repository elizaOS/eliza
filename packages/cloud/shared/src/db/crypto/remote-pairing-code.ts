/**
 * Defines the versioned keyed verifier stored for human-entered remote
 * pairing codes. The signed payload binds one challenge to its tenant, owner,
 * agent, session, purpose, and expiry; callers must still atomically consume
 * the corresponding pending row.
 */

const AGENT_VERIFIER_PREFIX = "hmac-sha256-v2";
const HOST_VERIFIER_PREFIX = "hmac-sha256-v3";
const VERIFIER_PATTERN = /^hmac-sha256-v([23]):(\d{13}):([0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE_PATTERN = /^\d{6}$/;
const PAIRING_PURPOSE = "remote-control";

/** Authoritative database identities covered by one pairing verifier. */
export interface RemotePairingVerifierContext {
  organizationId: string;
  userId: string;
  sessionId: string;
  agentId?: string;
  hostId?: string;
}

function pairingTarget(context: RemotePairingVerifierContext): {
  kind: "agent" | "host";
  id: string;
} {
  const hasAgent = typeof context.agentId === "string";
  const hasHost = typeof context.hostId === "string";
  if (hasAgent === hasHost) {
    throw new TypeError("remote pairing context must bind exactly one target");
  }
  return hasAgent ? { kind: "agent", id: context.agentId! } : { kind: "host", id: context.hostId! };
}

/** Reports whether an untrusted pairing identifier is a canonical UUID. */
export function isRemotePairingUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function textBuffer(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

function assertSecret(secret: string): ArrayBuffer {
  const secretBytes = textBuffer(secret);
  if (secretBytes.byteLength < 32) {
    throw new TypeError("REMOTE_PAIRING_HMAC_SECRET must contain at least 32 bytes");
  }
  return secretBytes;
}

function assertContext(context: RemotePairingVerifierContext): void {
  const target = pairingTarget(context);
  const entries = [
    ["organization", context.organizationId],
    ["user", context.userId],
    [target.kind, target.id],
    ["session", context.sessionId],
  ] as const;
  for (const [name, value] of entries) {
    if (!isRemotePairingUuid(value)) {
      throw new TypeError(`remote pairing ${name} id must be a canonical UUID`);
    }
  }
}

function assertInputs(
  context: RemotePairingVerifierContext,
  code: string,
  expiresAtMs: number,
): void {
  assertContext(context);
  if (!CODE_PATTERN.test(code)) {
    throw new TypeError("remote pairing code must contain exactly six digits");
  }
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1_000_000_000_000) {
    throw new TypeError("remote pairing expiry must be a millisecond timestamp");
  }
}

function signingPayload(
  context: RemotePairingVerifierContext,
  code: string,
  expiresAtMs: number,
): ArrayBuffer {
  const target = pairingTarget(context);
  if (target.kind === "agent") {
    return textBuffer(
      [
        "eliza.remote-pairing.v2",
        PAIRING_PURPOSE,
        context.organizationId,
        context.userId,
        target.id,
        context.sessionId,
        String(expiresAtMs),
        code,
      ].join("\0"),
    );
  }
  return textBuffer(
    [
      "eliza.remote-pairing.v3",
      "remote-runtime-host",
      context.organizationId,
      context.userId,
      target.id,
      context.sessionId,
      String(expiresAtMs),
      code,
    ].join("\0"),
  );
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    assertSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** Returns the signed expiry for a structurally valid verifier. */
export function remotePairingVerifierExpiryMs(verifier: string | null): number | null {
  const match = VERIFIER_PATTERN.exec(verifier ?? "");
  if (!match?.[2]) return null;
  const expiresAtMs = Number(match[2]);
  return Number.isSafeInteger(expiresAtMs) ? expiresAtMs : null;
}

/** Reports whether a verifier has a structurally valid, unexpired signed-expiry slot. */
export function isRemotePairingVerifierCurrent(verifier: string | null, nowMs: number): boolean {
  const expiresAtMs = remotePairingVerifierExpiryMs(verifier);
  return expiresAtMs !== null && expiresAtMs > nowMs;
}

/** Keeps active sessions and only pending sessions with a current v1 verifier. */
export function isRemotePairingSessionCurrent(
  status: "pending" | "active" | "denied" | "revoked" | "expired",
  verifier: string | null,
  nowMs: number,
): boolean {
  return (
    status === "active" || (status === "pending" && isRemotePairingVerifierCurrent(verifier, nowMs))
  );
}

/** Derives the versioned verifier persisted instead of the six-digit code. */
export async function deriveRemotePairingCodeVerifier(
  secret: string,
  context: RemotePairingVerifierContext,
  code: string,
  expiresAt: Date,
): Promise<string> {
  const expiresAtMs = expiresAt.getTime();
  assertInputs(context, code, expiresAtMs);
  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    signingPayload(context, code, expiresAtMs),
  );
  const prefix =
    pairingTarget(context).kind === "agent" ? AGENT_VERIFIER_PREFIX : HOST_VERIFIER_PREFIX;
  return `${prefix}:${expiresAtMs}:${bytesToHex(signature)}`;
}

/** Verifies the code, session binding, signature, and expiry without exposing the code. */
export async function verifyRemotePairingCodeVerifier(
  secret: string,
  context: RemotePairingVerifierContext,
  code: string,
  verifier: string,
  now: Date,
): Promise<boolean> {
  const match = VERIFIER_PATTERN.exec(verifier);
  if (!match?.[1] || !match[2] || !match[3]) return false;
  const target = pairingTarget(context);
  if ((match[1] === "2") !== (target.kind === "agent")) return false;
  const expiresAtMs = Number(match[2]);
  const nowMs = now.getTime();
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
    return false;
  }
  try {
    assertInputs(context, code, expiresAtMs);
  } catch {
    // error-policy:J3 untrusted pairing material is an explicit invalid result.
    return false;
  }
  const key = await importHmacKey(secret, "verify");
  return crypto.subtle.verify(
    "HMAC",
    key,
    hexToBuffer(match[3]),
    signingPayload(context, code, expiresAtMs),
  );
}
