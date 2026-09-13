/**
 * Exercises native bundle verification with actual Ed25519 keys and signatures.
 * A self-keyed export cannot recreate the live adapter's terminal key-disposal
 * authority, even when every artifact digest and signature is internally valid.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { canonicalJsonString } from "@elizaos/shared/canonical-json";
import { NativeVerifierContext } from "./native-attestation-channel.ts";

function signedExport() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const nonce = "ae".repeat(16);
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const expected = {
    attemptId: "owned-attempt-1",
    buildSha256: digest("observer build"),
    policySha256: digest("policy"),
    btfSha256: digest("BTF"),
    guardianSha256: digest("guardian"),
    signerSha256: digest("signer"),
    kernelRelease: "owned-test-kernel",
  };
  const manifest = {
    cleanupVerified: true,
    buildSha256: expected.buildSha256,
    policySha256: expected.policySha256,
    btfSha256: expected.btfSha256,
    guardianSha256: expected.guardianSha256,
    signerSha256: expected.signerSha256,
    kernelRelease: expected.kernelRelease,
    countersSha256: digest("counters"),
    drainSha256: digest("drain"),
    producerInventorySha256: digest("producer inventory"),
    monitorInventorySha256: digest("monitor inventory"),
    ledgerBytes: 128,
    ledgerRecords: 1,
    producerQuiesced: true,
    collectorExitCode: 0,
    ownedBpfObjectsGone: true,
    completionProof: "source-enforced-v1",

    context: expected,
    journalSha256: createHash("sha256")
      .update("retained ownership journal")
      .digest("hex"),
    ledgerSha256: createHash("sha256")
      .update("retained kernel records")
      .digest("hex"),
    nativeLedgerQualified: true,
    nonce,
    schema: "eliza.stability.native.v1",
  };
  const attestation = {
    manifest,
    signature: sign(
      null,
      Buffer.from(
        canonicalJsonString(manifest, {
          maxDepth: 16,
          maxNodes: 4096,
          maxOutputChars: 65536,
          sparseArrayHoles: "null",
          onUnbounded: () => {
            throw new Error("fixture structural evidence too large");
          },
        }),
      ),
      privateKey,
    ).toString("hex"),
    fingerprint: createHash("sha256").update(publicDer).digest("hex"),
  };
  return { nonce, expected, publicDer, attestation };
}

test("an internally valid self-keyed bundle cannot restore missing terminal acceptance", () => {
  const exported = signedExport();
  const reconstructed = new NativeVerifierContext(
    exported.nonce,
    exported.expected,
    exported.publicDer,
  );
  assert.throws(
    () => reconstructed.verifyArtifact(exported.attestation),
    /lacks trusted terminal acceptance/,
  );
});

test("native artifact verification rejects changed bytes before considering terminal trust", () => {
  const exported = signedExport();
  const reconstructed = new NativeVerifierContext(
    exported.nonce,
    exported.expected,
    exported.publicDer,
  );
  exported.attestation.manifest.ledgerSha256 = createHash("sha256")
    .update("different kernel records")
    .digest("hex");
  assert.throws(
    () => reconstructed.verifyArtifact(exported.attestation),
    /signature verification failed/,
  );
});

test("a valid signature for another attempt cannot satisfy the admitted run context", () => {
  const exported = signedExport();
  const reconstructed = new NativeVerifierContext(
    exported.nonce,
    { attemptId: "owned-attempt-2" },
    exported.publicDer,
  );
  assert.throws(
    () => reconstructed.verifyArtifact(exported.attestation),
    /does not match admitted context/,
  );
});

test("observer policy substitution is rejected even before terminal trust", () => {
  const exported = signedExport();
  const reconstructed = new NativeVerifierContext(
    exported.nonce,
    {
      ...exported.expected,
      policySha256: createHash("sha256").update("other policy").digest("hex"),
    },
    exported.publicDer,
  );
  assert.throws(
    () => reconstructed.verifyArtifact(exported.attestation),
    /does not match admitted context/,
  );
});

test("a purported signed result cannot omit terminal collector completion", () => {
  const exported = signedExport();
  const reconstructed = new NativeVerifierContext(
    exported.nonce,
    exported.expected,
    exported.publicDer,
  );
  exported.attestation.manifest.collectorExitCode = 1;
  assert.throws(
    () => reconstructed.verifyArtifact(exported.attestation),
    /producer completion is missing/,
  );
});
