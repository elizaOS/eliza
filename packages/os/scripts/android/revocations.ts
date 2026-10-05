/** Signed, expiring revocations. Sequence floor is independently pinned in the
 * reviewed trust policy so an older signed bulletin cannot silently roll back. */
import { createPublicKey, verify } from "node:crypto";
export function verifyRevocations(trust, now) {
  const fail = (message) => {
    throw new Error(`[android-revocations] ${message}`);
  };
  const bulletin = trust.revocationBulletin;
  if (
    bulletin?.schemaVersion !== 1 ||
    !Number.isSafeInteger(bulletin.sequence) ||
    !Number.isSafeInteger(trust.minimumRevocationSequence) ||
    bulletin.sequence < trust.minimumRevocationSequence
  )
    fail("missing or rolled-back revocation bulletin");
  if (
    !(
      Date.parse(bulletin.issuedAt) <= now &&
      Date.parse(bulletin.expiresAt) > now
    )
  )
    fail("revocation bulletin expired/not yet valid");
  if (
    !Array.isArray(bulletin.revokedReleaseDigests) ||
    !bulletin.revokedReleaseDigests.every((v) => /^[a-f0-9]{64}$/.test(v)) ||
    !Array.isArray(bulletin.revokedKeyIds) ||
    !bulletin.revokedKeyIds.every((v) => typeof v === "string")
  )
    fail("invalid revocations");
  const key = trust.keys.find(
    (k) =>
      k.id === bulletin.keyId &&
      k.roles?.includes("revocation") &&
      !trust.revokedKeyIds.includes(k.id) &&
      Date.parse(k.expiresAt) > now,
  );
  if (!key) fail("no trusted revocation authority");
  // A fixed tuple is the bulletin signing format; do not depend on JSON key order.
  const bytes = Buffer.from(
    JSON.stringify([
      bulletin.schemaVersion,
      bulletin.sequence,
      bulletin.issuedAt,
      bulletin.expiresAt,
      bulletin.revokedReleaseDigests,
      bulletin.revokedKeyIds,
    ]),
  );
  try {
    const publicKey = createPublicKey(key.publicKey);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      !verify(null, bytes, publicKey, Buffer.from(bulletin.signature, "base64"))
    )
      fail("invalid bulletin signature");
  } catch {
    fail("invalid bulletin signature");
  }
  return bulletin;
}
