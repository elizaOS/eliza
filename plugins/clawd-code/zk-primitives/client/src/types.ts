/**
 * Shared types for the Clawd ZK client SDK.
 */

import type { PublicKey } from "@solana/web3.js";
import type { LightSystemProgramCpi } from "@lightprotocol/stateless.js";

/** 32-byte field element (alt-bn128). */
export type Bytes32 = Uint8Array & { readonly length: 32 };

/** Groth16 proof triple. */
export interface Groth16Proof {
  /** G1 point (64 bytes after endianness fix). */
  a: Uint8Array;
  /** G2 point (128 bytes). */
  b: Uint8Array;
  /** G1 point (64 bytes). */
  c: Uint8Array;
  /** Serialized verifying key (alpha, beta, gamma, delta, gamma_abc). */
  verifyingKey: Uint8Array;
}

/** Inputs to the publish-attestation instruction. */
export interface PublishAttestationArgs {
  /** Signer paying for the transaction. Must equal the attester. */
  signer: PublicKey;
  /** 32-byte hash identifying the model being attested to. */
  modelHash: Bytes32;
  /** 32-byte commitment to the encrypted payload. */
  payloadCommitment: Bytes32;
  /** Nullifier that prevents double-publish. */
  nullifier: Bytes32;
  /** Groth16 proof over (attester, model_hash, payload_commitment, nullifier). */
  proof: Groth16Proof;
}

/** Inputs to the commit-encrypted-state instruction. */
export interface CommitStateArgs {
  signer: PublicKey;
  modelHash: Bytes32;
  ciphertextCommitment: Bytes32;
  stateVersion: number | bigint;
  proof: Groth16Proof;
}

/** Configuration for the Clawd ZK client. */
export interface ClawdZkClientConfig {
  /** Helius or other Solana RPC (with api-key embedded in URL). */
  rpc: any;
  /** Address of the deployed `clawd-zk` program. */
  programId: PublicKey;
  /** Photon indexer URL (defaults to Helius). */
  photonUrl?: string;
  /** API key for the RPC (separate from the URL for some providers). */
  apiKey?: string;
  /** Commitment level for RPC calls. */
  commitment?: "processed" | "confirmed" | "finalized";
}
