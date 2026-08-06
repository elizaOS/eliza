//! Nullifier module — compressed PDA nullifiers for the Clawd ZK primitive.
//!
//! Adapted from the reference `nullifier_creation` crate shipped by
//! Light Protocol. The empty-account pattern is intentional: existence
//! of the compressed account IS the proof that the action was taken.

use anchor_lang::prelude::*;
use light_sdk::{
    account::LightAccount,
    address::{v2::derive_address, Address},
    cpi::{v2::CpiAccounts, v2::LightSystemProgramCpi},
    instruction::{
        address::NewAddressParamsAssignedPacked, PackedAddressTreeInfo, ValidityProof,
    },
};

pub const NULLIFIER_PREFIX: &[u8] = b"clawd-zk-nullifier";

/// Compressed nullifier account. Empty struct by design — the very
/// existence of this account at the derived address proves the nullifier
/// was consumed.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct NullifierAccount {}

/// Instruction data shape required by the Light nullifier pattern.
/// Mirrors `nullifier_creation::NullifierInstructionData` so we can use
/// the same client tooling.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NullifierInstructionData {
    pub proof: ValidityProof,
    pub address_tree_info: PackedAddressTreeInfo,
    pub output_state_tree_index: u8,
    pub system_accounts_offset: u8,
}

/// Create N nullifier compressed accounts in a single CPI invocation.
/// Each nullifier becomes a compressed account at a unique derived
/// address; re-using a nullifier is impossible because Light's
/// address tree rejects the CPI.
pub fn create_nullifiers<'info>(
    nullifiers: &[[u8; 32]],
    data: NullifierInstructionData,
    signer: &AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    require!(!nullifiers.is_empty(), ClawdNullifierError::NoNullifiers);

    let light_cpi_accounts = CpiAccounts::new(
        signer,
        &remaining_accounts[data.system_accounts_offset as usize..],
        crate::LIGHT_CPI_SIGNER,
    );

    let address_tree_pubkey = data
        .address_tree_info
        .get_tree_pubkey(&light_cpi_accounts)
        .map_err(|_| error!(ClawdNullifierError::TreeLookupFailed))?;

    let mut cpi_builder = LightSystemProgramCpi::new_cpi(crate::LIGHT_CPI_SIGNER, data.proof);
    let mut new_address_params: Vec<NewAddressParamsAssignedPacked> =
        Vec::with_capacity(nullifiers.len());

    for (i, nullifier) in nullifiers.iter().enumerate() {
        let (address, address_seed) = derive_address(
            &[NULLIFIER_PREFIX, nullifier.as_slice()],
            &address_tree_pubkey,
            &crate::ID,
        );

        let nullifier_account = LightAccount::<NullifierAccount>::new_init(
            &crate::ID,
            Some(address),
            data.output_state_tree_index,
        );

        cpi_builder = cpi_builder.with_light_account(nullifier_account)?;
        new_address_params.push(
            data.address_tree_info
                .into_new_address_params_assigned_packed(address_seed, Some(i as u8)),
        );
    }

    cpi_builder
        .with_new_addresses(&new_address_params)
        .invoke(light_cpi_accounts)?;

    Ok(())
}

#[error_code]
pub enum ClawdNullifierError {
    #[msg("At least one nullifier must be provided.")]
    NoNullifiers,
    #[msg("Could not resolve the address tree pubkey from the packed info.")]
    TreeLookupFailed,
}
