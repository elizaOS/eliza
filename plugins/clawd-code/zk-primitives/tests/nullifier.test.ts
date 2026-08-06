/**
 * Integration tests for the @clawd/zk-client SDK.
 *
 * The TypeScript tests in this file exercise the off-chain pieces that
 * do NOT need the on-chain program: nullifier computation, public-input
 * packing, off-chain proof sanity checks, and end-to-end instruction
 * shape.
 *
 * On-chain tests live in `programs/clawd-zk/tests/` and require a
 * running `light test-validator`.
 */

import { describe, it, expect } from "vitest";
import { computeNullifier, computeNullifierBatch, NULLIFIER_PREFIX } from "../client/src/nullifier.js";
import {
  buildCommitPublicInputs,
  buildConsumePublicInputs,
  buildPublishPublicInputs,
  packPublicInputs,
  serializeProof,
  verifyGroth16Offchain,
} from "../client/src/proof.js";
import type { Bytes32, Groth16Proof } from "../client/src/types.js";

// ============================================================================
// Nullifier tests
// ============================================================================

describe("nullifier computation", () => {
  it("is deterministic for the same inputs", async () => {
    const secret = new Uint8Array(32).fill(0xab);
    const ctx = "model-attest:v1:abc123";
    const a = await computeNullifier({ secret, context: ctx });
    const b = await computeNullifier({ secret, context: ctx });
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it("changes when the secret changes", async () => {
    const s1 = new Uint8Array(32).fill(0x01);
    const s2 = new Uint8Array(32).fill(0x02);
    const ctx = "same-context";
    const a = await computeNullifier({ secret: s1, context: ctx });
    const b = await computeNullifier({ secret: s2, context: ctx });
    expect(a).not.toEqual(b);
  });

  it("changes when the context changes", async () => {
    const secret = new Uint8Array(32).fill(0x42);
    const a = await computeNullifier({ secret, context: "attestation-1" });
    const b = await computeNullifier({ secret, context: "attestation-2" });
    expect(a).not.toEqual(b);
  });

  it("supports a numeric nonce for multiple nullifiers per (secret, context)", async () => {
    const base = {
      secret: new Uint8Array(32).fill(0x55),
      context: "batch-test",
    };
    const batch = await computeNullifierBatch(base, 4);
    expect(batch.length).toBe(4);
    // All unique
    const set = new Set(batch.map((b) => Buffer.from(b).toString("hex")));
    expect(set.size).toBe(4);
  });

  it("rejects too-short secrets", async () => {
    await expect(
      computeNullifier({ secret: new Uint8Array(8), context: "x" }),
    ).rejects.toThrow(/at least 16 bytes/);
  });

  it("uses the documented NULLIFIER_PREFIX on-chain", () => {
    expect(Buffer.from(NULLIFIER_PREFIX).toString("utf8")).toBe(
      "clawd-zk-nullifier",
    );
  });
});

// ============================================================================
// Public input / proof packing tests
// ============================================================================

describe("public input packing", () => {
  const attester = new Uint8Array(32).fill(0x11);
  const modelHash = new Uint8Array(32).fill(0x22) as Bytes32;
  const payloadCommitment = new Uint8Array(32).fill(0x33) as Bytes32;
  const nullifier = new Uint8Array(32).fill(0x44) as Bytes32;

  it("builds the publish public input vector in the correct order", () => {
    const inputs = buildPublishPublicInputs({
      attester,
      modelHash,
      payloadCommitment,
      nullifier,
    });
    expect(inputs.length).toBe(4);
    expect(inputs[0]).toEqual(attester);
    expect(inputs[1]).toEqual(modelHash);
    expect(inputs[2]).toEqual(payloadCommitment);
    expect(inputs[3]).toEqual(nullifier);
  });

  it("builds the consume public input vector", () => {
    const consumer = new Uint8Array(32).fill(0x99);
    const attestationAddress = new Uint8Array(32).fill(0xaa) as Bytes32;
    const consumeNonce = new Uint8Array(32).fill(0xbb) as Bytes32;
    const inputs = buildConsumePublicInputs({
      consumer,
      attestationAddress,
      consumeNonce,
    });
    expect(inputs.length).toBe(3);
    expect(inputs[0]).toEqual(consumer);
    expect(inputs[1]).toEqual(attestationAddress);
    expect(inputs[2]).toEqual(consumeNonce);
  });

  it("builds the commit public input vector and encodes version as u64 LE", () => {
    const committer = new Uint8Array(32).fill(0xcc);
    const ciphertextCommitment = new Uint8Array(32).fill(0xdd) as Bytes32;
    const version = 7n;
    const inputs = buildCommitPublicInputs({
      committer,
      modelHash,
      ciphertextCommitment,
      stateVersion: version,
    });
    expect(inputs.length).toBe(4);
    // The 4th input is the version, encoded as u64 LE in the first 8 bytes.
    const view = new DataView((inputs[3] as Uint8Array).buffer);
    expect(view.getBigUint64(0, true)).toBe(version);
  });

  it("rejects a public input field of the wrong length", () => {
    const bad = new Uint8Array(31);
    expect(() => packPublicInputs([bad])).toThrow();
  });
});

// ============================================================================
// Proof serialization tests
// ============================================================================

describe("proof serialization", () => {
  const fakeProof: Groth16Proof = {
    a: new Uint8Array(64).fill(0xa1),
    b: new Uint8Array(128).fill(0xb1),
    c: new Uint8Array(64).fill(0xc1),
    verifyingKey: new Uint8Array(512).fill(0xd1),
  };

  it("accepts a well-formed proof", () => {
    const out = serializeProof(fakeProof);
    expect(out.proofA.length).toBe(64);
    expect(out.proofB.length).toBe(128);
    expect(out.proofC.length).toBe(64);
    expect(out.verifyingKey.length).toBe(512);
  });

  it("rejects a malformed proof point", () => {
    const bad = { ...fakeProof, a: new Uint8Array(32) };
    expect(() => serializeProof(bad)).toThrow(/proof\.a/);
  });

  it("off-chain sanity check passes for a well-formed proof", () => {
    const inputs = [
      new Uint8Array(32).fill(0x01) as Bytes32,
      new Uint8Array(32).fill(0x02) as Bytes32,
    ];
    const r = verifyGroth16Offchain({ proof: fakeProof, publicInputs: inputs });
    expect(r.ok).toBe(true);
  });
});
