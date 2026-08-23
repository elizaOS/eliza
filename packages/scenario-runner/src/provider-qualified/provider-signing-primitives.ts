/**
 * Defines lightweight manifest-signing bytes and Ed25519 public-key identity
 * shared by authorization and qualification. Provider deployment bundles use
 * these primitives without importing the full qualification decision engine.
 */

import { createHash, createPublicKey } from "node:crypto";
import {
  canonicalJson,
  canonicalJsonValue,
  type ProviderQualificationManifest,
} from "./manifest.ts";

export interface ProviderQualificationManifestSignature {
  keyId: string;
  manifestSha256: string;
  signature: string;
}

/** SPKI fingerprint used to pin an Ed25519 evidence-signing authority. */
export function providerObserverKeyId(publicKeyPem: string): string {
  if (!publicKeyPem.includes("-----BEGIN PUBLIC KEY-----")) {
    throw new Error("provider evidence pins must contain an SPKI public key");
  }
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("provider evidence keys must be Ed25519 public keys");
  }
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

/** Exact manifest bytes authorized by the operator before provider ingress. */
export function providerManifestSigningBytes(
  manifest: ProviderQualificationManifest,
): Buffer {
  return Buffer.from(
    canonicalJson(
      canonicalJsonValue(manifest, "providerQualificationManifest"),
    ),
    "utf8",
  );
}
