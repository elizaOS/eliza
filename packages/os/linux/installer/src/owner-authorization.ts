import { type KeyObject, verify } from "node:crypto";
import type { OwnerAuthorizationVerifier } from "./executor";
import type { InstallAuthorization } from "./types";

type Claims = Omit<InstallAuthorization, "credential">;
const DOMAIN = "elizaos-install-owner-authorization-v1";
const CREDENTIAL_PREFIX = "ed25519-v1:";

export class InstallOwnerAuthorizationError extends Error {
  readonly code = "ELIZAOS_INSTALL_OWNER_AUTHORIZATION_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstallOwnerAuthorizationError";
  }
}

/** Exact signing bytes for a trusted owner approval issuer. This encodes claims;
 * it does not establish owner approval, issue credentials, or authorize writes. */
export function ownerAuthorizationPayload(claims: Claims): Buffer {
  if (
    typeof claims.planId !== "string" ||
    typeof claims.inventoryFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(claims.planId) ||
    !/^[a-f0-9]{64}$/.test(claims.inventoryFingerprint) ||
    [claims.ownerId, claims.nonce].some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 256,
    ) ||
    [claims.issuedAt, claims.expiresAt].some(
      (value) =>
        typeof value !== "string" ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value,
    ) ||
    Date.parse(claims.expiresAt) <= Date.parse(claims.issuedAt)
  )
    throw new InstallOwnerAuthorizationError(
      "Invalid owner authorization claims.",
    );
  return Buffer.from(
    JSON.stringify([
      DOMAIN,
      claims.ownerId,
      claims.planId,
      claims.inventoryFingerprint,
      claims.issuedAt,
      claims.expiresAt,
      claims.nonce,
    ]),
    "utf8",
  );
}

/** The service owns this resolver and its revocation policy; request data must
 * never select a key file or provide a key. Null means unknown/revoked owner.
 * Resolver failures propagate, rather than becoming an authentication verdict. */
export type InstallOwnerKeyResolver = (
  ownerId: string,
) => Promise<KeyObject | null>;

/** Verify credential `ed25519-v1:<canonical base64url signature>` only.
 * The executor separately checks time, inventory, active owner and replay. */
export class Ed25519OwnerAuthorizationVerifier
  implements OwnerAuthorizationVerifier
{
  constructor(private readonly resolveKey: InstallOwnerKeyResolver) {}

  async verify(authorization: InstallAuthorization): Promise<boolean> {
    const claims = structuredClone(authorization);
    const payload = ownerAuthorizationPayload(claims);
    if (
      typeof claims.credential !== "string" ||
      !claims.credential.startsWith(CREDENTIAL_PREFIX)
    )
      return false;
    const encoded = claims.credential.slice(CREDENTIAL_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{86}$/.test(encoded)) return false;
    const signature = Buffer.from(encoded, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== encoded)
      return false;
    const key = await this.resolveKey(claims.ownerId);
    if (key === null) return false;
    if (key?.type !== "public" || key.asymmetricKeyType !== "ed25519")
      throw new InstallOwnerAuthorizationError(
        "Owner key resolver must return an Ed25519 public key.",
      );
    return verify(null, payload, key, signature);
  }
}
