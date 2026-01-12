#![allow(missing_docs)]

use alloy::{
    network::TransactionBuilder,
    primitives::{Address, Bytes, U256},
    providers::Provider,
    rpc::types::TransactionRequest,
    sol_types::SolValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{SupportedChain, Transaction};

/// Parameters for creating a governance proposal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposeParams {
    pub chain: SupportedChain,
    pub governor: Address,
    pub targets: Vec<Address>,
    pub values: Vec<U256>,
    pub calldatas: Vec<Bytes>,
    pub description: String,
}

impl ProposeParams {
    pub fn validate(&self) -> EVMResult<()> {
        if self.targets.is_empty() {
            return Err(EVMError::invalid_params("Targets array cannot be empty"));
        }

        if self.targets.len() != self.values.len() {
            return Err(EVMError::invalid_params(
                "Targets and values arrays must have same length",
            ));
        }

        if self.targets.len() != self.calldatas.len() {
            return Err(EVMError::invalid_params(
                "Targets and calldatas arrays must have same length",
            ));
        }

        if self.description.is_empty() {
            return Err(EVMError::invalid_params("Description cannot be empty"));
        }

        Ok(())
    }
}

pub struct ProposeAction {
    provider: Arc<WalletProvider>,
}

impl ProposeAction {
    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self { provider }
    }

    pub async fn execute(&self, params: ProposeParams) -> EVMResult<Transaction> {
        params.validate()?;

        let chain_provider = self.provider.provider(params.chain)?;
        let chain_id = params.chain.chain_id();
        let from_address = self.provider.address();

        // Encode the propose function call
        // propose(address[] targets, uint256[] values, bytes[] calldatas, string description)
        // Function selector: 0x7d5e81e2 for propose(address[],uint256[],bytes[],string)
        let selector: [u8; 4] = [0x7d, 0x5e, 0x81, 0xe2];

        // ABI encode the parameters
        let encoded = (
            params.targets.clone(),
            params.values.clone(),
            params.calldatas.clone(),
            params.description.clone(),
        )
            .abi_encode();

        let mut calldata = Vec::with_capacity(4 + encoded.len());
        calldata.extend_from_slice(&selector);
        calldata.extend_from_slice(&encoded);

        let tx = TransactionRequest::default()
            .with_to(params.governor)
            .with_value(U256::ZERO)
            .with_input(Bytes::from(calldata));

        let pending_tx = chain_provider.send_transaction(tx).await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to send propose transaction: {e}"),
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
                format!("Propose transaction reverted: {tx_hash}"),
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
