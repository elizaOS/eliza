/**
 * @clawd/zk-client
 *
 * TypeScript client SDK for the Clawd ZK primitive on Solana.
 *
 * The SDK wraps three things:
 *   1. **Nullifier computation** — deterministic hashes from a (secret, context) pair.
 *   2. **Groth16 proof assembly** — wire-format packing for on-chain verification.
 *   3. **Light Protocol integration** — fetching validity proofs from the
 *      Photon indexer, packing system accounts, building CPI-ready instructions.
 *
 * ## Quick start
 *
 * ```ts
 * import { ClawdZkClient, computeNullifier, buildPublicInputs } from "@clawd/zk-client";
 * import { createSolanaRpc, createKeyPairSignerFromBytes } from "@solana/kit";
 *
 * const rpc = createSolanaRpc("https://mainnet.helius-rpc.com?api-key=...");
 * const signer = await createKeyPairSignerFromBytes(secretKey);
 * const client = new ClawdZkClient({
 *   rpc,
 *   programId: "CLAWDzk...",
 *   photonUrl: "https://mainnet.helius-rpc.com",
 *   apiKey: "...",
 * });
 *
 * // Compute a nullifier from a (secret, context) pair.
 * const nullifier = await computeNullifier({
 *   secret: signer.secretKey,
 *   context: Buffer.from("model-attestation-2026-06-15"),
 * });
 *
 * // Build the publish-attestation instruction.
 * const ix = await client.publishAttestation({
 *   signer,
 *   modelHash: hexToBytes("ab12..."),
 *   payloadCommitment: hexToBytes("cd34..."),
 *   nullifier,
 *   proof: { a: proofA, b: proofB, c: proofC, verifyingKey },
 * });
 *
 * // Send it.
 * await client.send([ix]);
 * ```
 */

export * from "./nullifier.js";
export * from "./proof.js";
export * from "./state.js";
export * from "./client.js";
export * from "./types.js";
