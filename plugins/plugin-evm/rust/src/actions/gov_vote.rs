#![allow(missing_docs)]

use alloy::{
    network::TransactionBuilder,
    primitives::{Address, Bytes, U256},
    providers::Provider,
    rpc::types::TransactionRequest,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{SupportedChain, Transaction};

/// Vote support types
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[repr(u8)]
pub enum VoteSupport {
    Against = 0,
    For = 1,
    Abstain = 2,
}

/// Parameters for casting a governance vote
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteParams {
    pub chain: SupportedChain,
    pub governor: Address,
    pub proposal_id: U256,
    pub support: VoteSupport,
}

impl VoteParams {
    pub fn validate(&self) -> EVMResult<()> {
        // Proposal ID should be non-zero (though 0 could technically be valid)
        Ok(())
    }
}

pub struct VoteAction {
    provider: Arc<WalletProvider>,
}

impl VoteAction {
    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self { provider }
    }

    pub async fn execute(&self, params: VoteParams) -> EVMResult<Transaction> {
        params.validate()?;

        let chain_provider = self.provider.provider(params.chain)?;
        let chain_id = params.chain.chain_id();
        let from_address = self.provider.address();

        // Encode the castVote function call
        // castVote(uint256 proposalId, uint8 support)
        // Function selector: 0x56781388
        let selector: [u8; 4] = [0x56, 0x78, 0x13, 0x88];

        // ABI encode the parameters manually
        // uint256 proposalId (32 bytes) + uint8 support padded to 32 bytes
        let mut calldata = Vec::with_capacity(68);
        calldata.extend_from_slice(&selector);
        calldata.extend_from_slice(&params.proposal_id.to_be_bytes::<32>());
        // uint8 is padded to 32 bytes (left-padded with zeros)
        calldata.extend_from_slice(&[0u8; 31]);
        calldata.push(params.support as u8);

        let tx = TransactionRequest::default()
            .with_to(params.governor)
            .with_value(U256::ZERO)
            .with_input(Bytes::from(calldata));

        let pending_tx = chain_provider.send_transaction(tx).await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to send vote transaction: {e}"),
            )
        })?;

        let tx_hash = *pending_tx.tx_hash();
        let receipt = pending_tx.get_receipt().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to get receipt: {e}"),
            )
        })?;

        if !receipt.status() {
            return Err(EVMError::new(
                EVMErrorCode::ContractRevert,
                format!("Vote transaction reverted: {tx_hash}"),
            ));
        }

        Ok(Transaction {
            hash: tx_hash,
            from: from_address,
            to: params.governor,
            value: U256::ZERO,
            data: None,
            chain_id: Some(chain_id),
        })
    }
}
