//! # Clawd ZK Primitive
//!
//! On-chain program that provides ZK primitives for the Solana Clawd AI
//! model stack. Uses Light Protocol for compressed state (~67M leaves per
//! state tree, 15k lamports per compressed nullifier).
//!
//! ## Capabilities
//!
//! 1. **Nullifier registry** — prevent double-publish / double-claim of
//!    AI model attestations. A nullifier is derived from a (secret, context)
//!    pair, and its on-chain existence proves the action was taken once.
//!
//! 2. **Groth16 proof verification** — verify a Groth16 zk-SNARK that
//!    attests to model inference correctness, encrypted state commitment,
//!    or any other relation the agent produces off-chain.
//!
//! 3. **Compressed state** — model metadata, attestation records, and
//!    encrypted parameters live in Light Protocol state trees (rent-free,
//!    ~5k lamports per tree per tx).
//!
//! 4. **Encrypted state** — opaque ciphertext blobs are committed in
//!    compressed accounts. Decryption happens off-chain with a key derived
//!    from the Groth16 proof's private inputs.
//!
//! ## Architecture
//!
//! ```text
//!   ┌──────────┐      ┌────────────────┐      ┌──────────────┐
//!   │  Agent   │─────▶│  Clawd ZK      │─────▶│ Light System │
//!   │ (off-chain) │  ①│  Program       │  ③  │ Program      │
//!   │          │      │  (verifies +   │      │ (CPI: tree   │
//!   │ ②  ──────│─────▶│   cpi's null)  │      │  updates)    │
//!   │ Groth16  │      └────────────────┘      └──────────────┘
//!   │ proof    │                │                       │
//!   └──────────┘                ▼                       ▼
//!                       ┌────────────────┐      ┌──────────────┐
//!                       │ Photon Indexer │◀─────│ State Trees  │
//!                       │  (RPC read)    │      │  (Merkle)    │
//!                       └────────────────┘      └──────────────┘
//! ```
//!
//! ① Agent sends nullifiers + Groth16 proof + instruction data
//! ② Agent supplies Groth16 proof as instruction arg (the verifier
//!    re-derives the public inputs and checks the proof)
//! ③ Program CPIs the Light System Program to update compressed state

use anchor_lang::prelude::*;

pub mod nullifier;
pub mod proof;
pub mod state;

use proof::verify_groth16;

declare_id!("CLAWDzk11111111111111111111111111111111111");

/// Light CPI signer (auto-derived from this program's ID by the Light SDK).
/// Set at IDL-build time via `anchor idl build`. Placeholder for the scaffold.
pub const LIGHT_CPI_SIGNER: Pubkey = Pubkey::new_from_array([
    0x9C, 0x9C, 0x5A, 0xCB, 0x9F, 0x88, 0xC0, 0xA5,
    0xE2, 0xD0, 0xBC, 0xB4, 0x42, 0xD6, 0xC3, 0x70,
    0x42, 0xC2, 0xCC, 0x1F, 0x2D, 0x18, 0x9D, 0x6E,
    0x29, 0x68, 0x9B, 0xC3, 0xA7, 0xE1, 0x3D, 0xB5,
]);

#[program]
pub mod clawd_zk {
    use super::*;

    /// Publish a new model attestation. Creates a nullifier to mark this
    /// attestation as published exactly once, and writes an attestation
    /// record (compressed) with the model hash, attester pubkey, and
    /// an optional encrypted payload commitment.
    ///
    /// Requires a Groth16 proof that the attester is authorized to publish
    /// for this model. The proof's public inputs must include the
    /// (model_hash, nullifier) pair so they cannot be relabeled.
    pub fn publish_attestation<'info>(
        ctx: Context<'_, '_, '_, 'info, PublishAttestationAccounts<'info>>,
        data: PublishAttestationData,
        nullifiers: Vec<[u8; 32]>,
    ) -> Result<()> {
        // 1. Verify the Groth16 proof. The proof attests that the
        //    attester knows a valid private key for `model_hash` and
        //    that `nullifier` is the correct deterministic derivation.
        let public_inputs = build_public_inputs(
            &ctx.accounts.attester.key(),
            &data.model_hash,
            &data.payload_commitment,
            &nullifiers,
        );
        verify_groth16(
            &data.proof_a,
            &data.proof_b,
            &data.proof_c,
            &public_inputs,
            &data.verifying_key,
        )
        .map_err(|_| error!(ClawdZkError::InvalidProof))?;

        // 2. Create the nullifier compressed accounts via Light CPI.
        nullifier::create_nullifiers(
            &nullifiers,
            data.nullifier_data,
            ctx.accounts.attester.as_ref(),
            ctx.remaining_accounts,
        )?;

        // 3. Write the attestation record (compressed) with the metadata.
        //    Implemented as a separate CPI to keep the nullifier logic
        //    isolated and testable.
        state::write_attestation(
            &data.model_hash,
            &data.payload_commitment,
            &ctx.accounts.attester.key(),
            data.state_data,
            ctx.accounts.attester.as_ref(),
            ctx.remaining_accounts,
        )?;

        msg!(
            "Clawd ZK: published attestation for model {} by {} (nullifier root: {:?})",
            hex::encode(&data.model_hash[..8]),
            ctx.accounts.attester.key(),
            &nullifiers[0][..8]
        );
        Ok(())
    }

    /// Verify an existing attestation and update its status (e.g. mark
    /// as "consumed" by a downstream consumer). Does not create a new
    /// nullifier — it consumes the attestation record's compressed slot.
    pub fn consume_attestation<'info>(
        ctx: Context<'_, '_, '_, 'info, ConsumeAttestationAccounts<'info>>,
        data: ConsumeAttestationData,
    ) -> Result<()> {
        // Verify a Groth16 proof that the consumer is allowed to consume
        // this attestation (e.g. they own the downstream license).
        let public_inputs = build_consume_public_inputs(
            &ctx.accounts.consumer.key(),
            &data.attestation_address,
            &data.consume_nonce,
        );
        verify_groth16(
            &data.proof_a,
            &data.proof_b,
            &data.proof_c,
            &public_inputs,
            &data.verifying_key,
        )
        .map_err(|_| error!(ClawdZkError::InvalidProof))?;

        state::consume_attestation(
            &data.attestation_address,
            &data.consume_nonce,
            &ctx.accounts.consumer.key(),
            data.state_data,
            ctx.accounts.consumer.as_ref(),
            ctx.remaining_accounts,
        )?;

        msg!(
            "Clawd ZK: consumed attestation {} by {}",
            hex::encode(&data.attestation_address[..8]),
            ctx.accounts.consumer.key()
        );
        Ok(())
    }

    /// Commit encrypted model state (weights, gradients, etc.) to a
    /// compressed account. The Groth16 proof attests that the committer
    /// knows the plaintext (or has a valid license to publish it).
    pub fn commit_encrypted_state<'info>(
        ctx: Context<'_, '_, '_, 'info, CommitStateAccounts<'info>>,
        data: CommitStateData,
    ) -> Result<()> {
        let public_inputs = build_commit_public_inputs(
            &ctx.accounts.committer.key(),
            &data.model_hash,
            &data.ciphertext_commitment,
            data.state_version,
        );
        verify_groth16(
            &data.proof_a,
            &data.proof_b,
            &data.proof_c,
            &public_inputs,
            &data.verifying_key,
        )
        .map_err(|_| error!(ClawdZkError::InvalidProof))?;

        state::commit_encrypted(
            &data.model_hash,
            &data.ciphertext_commitment,
            data.state_version,
            &ctx.accounts.committer.key(),
            data.state_data,
            ctx.accounts.committer.as_ref(),
            ctx.remaining_accounts,
        )?;

        msg!(
            "Clawd ZK: committed encrypted state for model {} (v{}, ciphertext root: {:?})",
            hex::encode(&data.model_hash[..8]),
            data.state_version,
            &data.ciphertext_commitment[..8]
        );
        Ok(())
    }
}

// ============================================================================
// Instruction accounts + data
// ============================================================================

#[derive(Accounts)]
pub struct PublishAttestationAccounts<'info> {
    #[account(mut)]
    pub attester: Signer<'info>,
}

#[derive(Accounts)]
pub struct ConsumeAttestationAccounts<'info> {
    #[account(mut)]
    pub consumer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CommitStateAccounts<'info> {
    #[account(mut)]
    pub committer: Signer<'info>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PublishAttestationData {
    /// 32-byte hash of the model being attested to.
    pub model_hash: [u8; 32],
    /// 32-byte commitment to the encrypted attestation payload.
    pub payload_commitment: [u8; 32],
    /// Groth16 proof point A (G1, 64 bytes after endianness fix).
    pub proof_a: [u8; 64],
    /// Groth16 proof point B (G2, 128 bytes).
    pub proof_b: [u8; 128],
    /// Groth16 proof point C (G1, 64 bytes).
    pub proof_c: [u8; 64],
    /// Groth16 verifying key (variable length; pinned at compile time
    /// by the client's circuit).
    pub verifying_key: Vec<u8>,
    /// Light Protocol data for writing the compressed attestation record.
    pub state_data: state::WriteStateData,
    /// Light Protocol data for creating the nullifier compressed accounts.
    pub nullifier_data: nullifier::NullifierInstructionData,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConsumeAttestationData {
    /// Compressed account address of the attestation being consumed.
    pub attestation_address: [u8; 32],
    /// Unique nonce for this consumption (prevents replay of the
    /// consume-proof itself).
    pub consume_nonce: [u8; 32],
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub verifying_key: Vec<u8>,
    pub state_data: state::ConsumeStateData,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CommitStateData {
    pub model_hash: [u8; 32],
    /// Commitment to the ciphertext (Poseidon hash of (ct, nonce)).
    pub ciphertext_commitment: [u8; 32],
    /// Monotonically increasing version for the same model.
    pub state_version: u64,
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub verifying_key: Vec<u8>,
    pub state_data: state::WriteStateData,
}

// ============================================================================
// Helpers
// ============================================================================

fn build_public_inputs(
    attester: &Pubkey,
    model_hash: &[u8; 32],
    payload_commitment: &[u8; 32],
    nullifiers: &[[u8; 32]],
) -> Vec<[u8; 32]> {
    let mut out = Vec::with_capacity(3 + nullifiers.len());
    out.push(*attester.to_bytes());
    out.push(*model_hash);
    out.push(*payload_commitment);
    for n in nullifiers {
        out.push(*n);
    }
    out
}

fn build_consume_public_inputs(
    consumer: &Pubkey,
    attestation_address: &[u8; 32],
    consume_nonce: &[u8; 32],
) -> Vec<[u8; 32]> {
    vec![
        *consumer.to_bytes(),
        *attestation_address,
        *consume_nonce,
    ]
}

fn build_commit_public_inputs(
    committer: &Pubkey,
    model_hash: &[u8; 32],
    ciphertext_commitment: &[u8; 32],
    state_version: u64,
) -> Vec<[u8; 32]> {
    let mut version_bytes = [0u8; 32];
    version_bytes[..8].copy_from_slice(&state_version.to_le_bytes());
    vec![
        *committer.to_bytes(),
        *model_hash,
        *ciphertext_commitment,
        version_bytes,
    ]
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ClawdZkError {
    #[msg("The Groth16 proof did not verify against the public inputs.")]
    InvalidProof,
    #[msg("The provided public inputs are malformed or out of range.")]
    InvalidPublicInputs,
    #[msg("The compressed account already exists (nullifier collision).")]
    NullifierAlreadyExists,
    #[msg("The state tree / address tree pubkey is not a known Light Protocol tree.")]
    UnknownTree,
}
