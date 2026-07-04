/**
 * Exercises verifyTeeRevocationManifest's fail-closed signature checks over a
 * revocation manifest: an unsigned manifest is allowed only when no trusted
 * authority is anchored, a claimed authority without an anchor is rejected, a
 * correctly signed manifest verifies, and tampered / unknown-authority /
 * unsigned-with-anchor manifests are refused. Also pins that
 * canonicalizeRevocationBody is key-order independent. Deterministic — real
 * node:crypto Ed25519 keys generated in-memory.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRevocationBody,
  type TeeRevocationManifest,
  verifyTeeRevocationManifest,
} from "./tee-revocation.ts";

function ed25519Authority() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signManifest = (manifest: TeeRevocationManifest): string =>
    sign(
      null,
      Buffer.from(canonicalizeRevocationBody(manifest), "utf8"),
      privateKey,
    ).toString("base64");
  return { pem, signManifest };
}

const baseManifest: TeeRevocationManifest = {
  schemaVersion: 1,
  authority: "eliza-revocation-authority",
  revokedSecurityVersions: [2, 3],
  revokedMeasurements: { agent: ["sha256:dead"] },
};

describe("TEE revocation manifest signature verification", () => {
  it("permits an unsigned manifest when no trusted authority is configured", () => {
    const { signature: _drop, authority: _a, ...unsigned } = baseManifest;
    expect(
      verifyTeeRevocationManifest(unsigned as TeeRevocationManifest, {
        trustedAuthorities: {},
      }),
    ).toEqual({ verified: true });
  });

  it("rejects a manifest that claims an authority when no anchor is configured", () => {
    expect(
      verifyTeeRevocationManifest(baseManifest, { trustedAuthorities: {} }),
    ).toMatchObject({ verified: false, reason: "untrusted-authority" });
  });

  it("verifies a correctly signed manifest against the trusted key", () => {
    const { pem, signManifest } = ed25519Authority();
    const manifest = { ...baseManifest, signature: signManifest(baseManifest) };
    expect(
      verifyTeeRevocationManifest(manifest, {
        trustedAuthorities: { [baseManifest.authority as string]: pem },
      }),
    ).toEqual({ verified: true, authority: baseManifest.authority });
  });

  it("rejects a signed manifest whose body was tampered after signing", () => {
    const { pem, signManifest } = ed25519Authority();
    const signature = signManifest(baseManifest);
    const tampered: TeeRevocationManifest = {
      ...baseManifest,
      signature,
      revokedSecurityVersions: [2, 3, 99], // attacker adds/removes a revocation
    };
    expect(
      verifyTeeRevocationManifest(tampered, {
        trustedAuthorities: { [baseManifest.authority as string]: pem },
      }),
    ).toMatchObject({ verified: false, reason: "invalid-signature" });
  });

  it("rejects a manifest signed by an unknown authority", () => {
    const trusted = ed25519Authority();
    const rogue = ed25519Authority();
    const manifest = {
      ...baseManifest,
      signature: rogue.signManifest(baseManifest),
    };
    // Trusted map holds a different key for this authority id -> signature fails.
    expect(
      verifyTeeRevocationManifest(manifest, {
        trustedAuthorities: { [baseManifest.authority as string]: trusted.pem },
      }),
    ).toMatchObject({ verified: false, reason: "invalid-signature" });
  });

  it("rejects an unsigned manifest when an anchor is configured", () => {
    const { pem } = ed25519Authority();
    const { signature: _drop, ...unsigned } = baseManifest;
    expect(
      verifyTeeRevocationManifest(unsigned as TeeRevocationManifest, {
        trustedAuthorities: { [baseManifest.authority as string]: pem },
      }),
    ).toMatchObject({ verified: false, reason: "unsigned-manifest" });
  });

  it("canonicalization is key-order independent", () => {
    const a: TeeRevocationManifest = {
      schemaVersion: 1,
      authority: "x",
      revokedSecurityVersions: [1],
    };
    const b: TeeRevocationManifest = {
      revokedSecurityVersions: [1],
      authority: "x",
      schemaVersion: 1,
    };
    expect(canonicalizeRevocationBody(a)).toEqual(
      canonicalizeRevocationBody(b),
    );
  });
});
