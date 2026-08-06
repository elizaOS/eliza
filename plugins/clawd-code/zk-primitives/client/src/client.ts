/**
 * ClawdZkClient — high-level orchestrator.
 *
 * Glues together nullifier computation, Groth16 proof assembly, and
 * Light Protocol validity-proof fetching into single-method calls
 * that produce ready-to-sign Solana instructions.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ClawdZkClientConfig,
  CommitStateArgs,
  PublishAttestationArgs,
  Groth16Proof,
} from "./types.js";
import {
  buildCommitPublicInputs,
  buildPublishPublicInputs,
  packPublicInputs,
  serializeProof,
} from "./proof.js";
import {
  fetchAddressTreeV2,
  fetchRandomStateTreeV2,
  fetchValidityProofV2,
  packAccounts,
} from "./state.js";
import { computeNullifier, deriveNullifierAddress } from "./nullifier.js";

const PROGRAM_IDENTITY: PublicKey = new PublicKey(
  "CLAWDzk11111111111111111111111111111111111",
);

export class ClawdZkClient {
  readonly rpc: any;
  readonly programId: PublicKey;
  readonly photonUrl: string;
  readonly apiKey?: string;
  readonly commitment: "processed" | "confirmed" | "finalized";

  constructor(config: ClawdZkClientConfig) {
    this.rpc = config.rpc;
    this.programId = config.programId ?? PROGRAM_IDENTITY;
    this.photonUrl = config.photonUrl ?? "";
    this.apiKey = config.apiKey;
    this.commitment = config.commitment ?? "confirmed";
  }

  /**
   * Build a `publish_attestation` instruction. The caller must supply
   * the Groth16 proof (already generated off-chain). This method does
   * the rest: derives the nullifier address, fetches the validity
   * proof, packs the system accounts.
   */
  async publishAttestation(args: PublishAttestationArgs): Promise<TransactionInstruction> {
    // 1. Sanity-check and serialize the proof.
    const proof = serializeProof(args.proof);

    // 2. Derive the nullifier's compressed-account address.
    const addressTree = await fetchAddressTreeV2(this.rpc);
    const { address: nullifierAddress } = await deriveNullifierAddress(
      this.programId,
      addressTree,
      args.nullifier,
    );

    // 3. Fetch a validity proof (proves the nullifier address does not exist).
    const validity = await fetchValidityProofV2({
      rpc: this.rpc,
      hashes: [],
      addressesWithTrees: [{ address: nullifierAddress, tree: addressTree }],
    });

    // 4. Fetch a random state tree for the new output.
    const stateTree = await fetchRandomStateTreeV2(this.rpc);

    // 5. Pack system accounts.
    const { packed, addressMerkleTreeIndex, outputStateTreeIndex } =
      await packAccounts({
        rpc: this.rpc,
        programId: this.programId,
        treeInfo: {
          addressTree,
          stateTree: stateTree.tree,
          outputQueue: stateTree.queue,
        },
        proof: validity,
      });

    const systemStart = 0; // convention: system accounts are first in remaining
    const systemAccountsOffset = systemStart;

    // 6. Build the canonical public input vector.
    const publicInputs = buildPublishPublicInputs({
      attester: args.signer.toBytes(),
      modelHash: args.modelHash,
      payloadCommitment: args.payloadCommitment,
      nullifier: args.nullifier,
    });

    // 7. Serialize the on-chain instruction data.
    const data = {
      modelHash: [...args.modelHash],
      payloadCommitment: [...args.payloadCommitment],
      proofA: [...proof.proofA],
      proofB: [...proof.proofB],
      proofC: [...proof.proofC],
      verifyingKey: [...proof.verifyingKey],
      publicInputsPacked: [...packPublicInputs(publicInputs)],
      stateData: {
        proof: { 0: [...validity.compressedProof] },
        stateTreeInfo: {
          stateMerkleTreePubkeyIndex: outputStateTreeIndex,
          outputQueuePubkeyIndex: outputStateTreeIndex,
          rootIndex: validity.rootIndices[0] ?? 0,
        },
        outputStateTreeIndex,
        systemAccountsOffset,
      },
      nullifierData: {
        proof: { 0: [...validity.compressedProof] },
        addressTreeInfo: {
          addressMerkleTreePubkeyIndex: addressMerkleTreeIndex,
          addressQueuePubkeyIndex: addressMerkleTreeIndex,
          rootIndex: validity.rootIndices[0] ?? 0,
        },
        outputStateTreeIndex,
        systemAccountsOffset,
      },
    };

    // 8. Encode the discriminator for `publish_attestation` (Anchor IDL).
    const discriminator = sha256("global:publish_attestation").slice(0, 8);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: args.signer, isSigner: true, isWritable: true },
        // ...remaining accounts appended by `packed.to_account_metas()`
        ...(packed as any).to_account_metas(),
      ],
      data: encodeInstructionData(discriminator, data),
    });

    return ix;
  }

  /**
   * Build a `commit_encrypted_state` instruction. The off-chain
   * committer must supply a Groth16 proof that they know the
   * plaintext (or have a valid license).
   */
  async commitEncryptedState(args: CommitStateArgs): Promise<TransactionInstruction> {
    const proof = serializeProof(args.proof);
    const stateTree = await fetchRandomStateTreeV2(this.rpc);

    // Validity proof for a write (no address creation).
    const validity = await fetchValidityProofV2({
      rpc: this.rpc,
      hashes: [],
      addressesWithTrees: [],
    });

    const { packed, outputStateTreeIndex } = await packAccounts({
      rpc: this.rpc,
      programId: this.programId,
      treeInfo: {
        addressTree: stateTree.tree, // dummy; not used for write-without-address
        stateTree: stateTree.tree,
        outputQueue: stateTree.queue,
      },
      proof: validity,
    });

    const publicInputs = buildCommitPublicInputs({
      committer: args.signer.toBytes(),
      modelHash: args.modelHash,
      ciphertextCommitment: args.ciphertextCommitment,
      stateVersion: args.stateVersion,
    });

    const data = {
      modelHash: [...args.modelHash],
      ciphertextCommitment: [...args.ciphertextCommitment],
      stateVersion: typeof args.stateVersion === "bigint"
        ? Number(args.stateVersion)
        : args.stateVersion,
      proofA: [...proof.proofA],
      proofB: [...proof.proofB],
      proofC: [...proof.proofC],
      verifyingKey: [...proof.verifyingKey],
      publicInputsPacked: [...packPublicInputs(publicInputs)],
      stateData: {
        proof: { 0: [...validity.compressedProof] },
        stateTreeInfo: {
          stateMerkleTreePubkeyIndex: outputStateTreeIndex,
          outputQueuePubkeyIndex: outputStateTreeIndex,
          rootIndex: validity.rootIndices[0] ?? 0,
        },
        outputStateTreeIndex,
        systemAccountsOffset: 0,
      },
    };

    const discriminator = sha256("global:commit_encrypted_state").slice(0, 8);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: args.signer, isSigner: true, isWritable: true },
        ...(packed as any).to_account_metas(),
      ],
      data: encodeInstructionData(discriminator, data),
    });
  }
}

// ============================================================================
// Internal encoding helpers
// ============================================================================

function sha256(s: string): Uint8Array {
  // Lightweight synchronous SHA-256. For production, use `@noble/hashes`.
  // We import dynamically to keep the bundle small.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(s).digest();
}

function encodeInstructionData(discriminator: Uint8Array, data: any): Buffer {
  // Borsh-style manual encoding. For production, use `@coral-xyz/anchor`
  // BorshInstructionCoder. We keep this minimal here.
  const json = JSON.stringify(data);
  const jsonBytes = new TextEncoder().encode(json);
  return Buffer.concat([Buffer.from(discriminator), Buffer.from(jsonBytes)]);
}
