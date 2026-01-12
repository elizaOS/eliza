#![allow(missing_docs)]

use alloy::{
    network::TransactionBuilder,
    primitives::{Address, Bytes, FixedBytes, U256},
    providers::Provider,
    rpc::types::TransactionRequest,
    sol_types::SolValue,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{SupportedChain, Transaction};

/// Parameters for queueing a governance proposal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueParams {
    pub chain: SupportedChain,
    pub governor: Address,
    pub targets: Vec<Address>,
    pub values: Vec<U256>,
    pub calldatas: Vec<Bytes>,
    pub description_hash: FixedBytes<32>,
}

impl QueueParams {
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

        Ok(())
    }
}

pub struct QueueAction {
    provider: Arc<WalletProvider>,
}

impl QueueAction {
    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self { provider }
    }

    pub async fn execute(&self, params: QueueParams) -> EVMResult<Transaction> {
        params.validate()?;

        let chain_provider = self.provider.provider(params.chain)?;
        let chain_id = params.chain.chain_id();
        let from_address = self.provider.address();

        // Encode the queue function call
        // queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)
        // Function selector: 0x160cbed7
        let selector: [u8; 4] = [0x16, 0x0c, 0xbe, 0xd7];

        // ABI encode the parameters
        let encoded = (
            params.targets.clone(),
            params.values.clone(),
            params.calldatas.clone(),
            params.description_hash,
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
                format!("Failed to send queue transaction: {e}"),
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
                format!("Queue transaction reverted: {tx_hash}"),
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
