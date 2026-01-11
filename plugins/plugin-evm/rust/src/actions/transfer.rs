#![allow(missing_docs)]
//! Token transfer action implementation
//!
//! Handles native token and ERC20 token transfers on EVM chains.

use alloy::{
    network::TransactionBuilder,
    primitives::{Address, Bytes, U256},
    providers::Provider,
    rpc::types::TransactionRequest,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::DEFAULT_DECIMALS;
use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{parse_amount, SupportedChain, Transaction};

/// Parameters for a token transfer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferParams {
    /// Source chain
    pub from_chain: SupportedChain,
    /// Recipient address
    pub to_address: Address,
    /// Amount to transfer (human readable, e.g., "1.5")
    pub amount: String,
    /// Optional calldata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Bytes>,
    /// Optional token address (for ERC20 transfers)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<Address>,
}

impl TransferParams {
    /// Create new transfer parameters for native token
    #[must_use]
    pub fn native(chain: SupportedChain, to: Address, amount: impl Into<String>) -> Self {
        Self {
            from_chain: chain,
            to_address: to,
            amount: amount.into(),
            data: None,
            token: None,
        }
    }

    /// Create new transfer parameters for ERC20 token
    #[must_use]
    pub fn erc20(
        chain: SupportedChain,
        to: Address,
        token: Address,
        amount: impl Into<String>,
    ) -> Self {
        Self {
            from_chain: chain,
            to_address: to,
            amount: amount.into(),
            data: None,
            token: Some(token),
        }
    }

    /// Add calldata to the transfer
    #[must_use]
    pub fn with_data(mut self, data: Bytes) -> Self {
        self.data = Some(data);
        self
    }

    /// Validate the transfer parameters
    pub fn validate(&self) -> EVMResult<()> {
        let amount: f64 = self.amount.parse().map_err(|_| {
            EVMError::invalid_params(format!("Invalid amount: {}", self.amount))
        })?;

        if amount <= 0.0 {
            return Err(EVMError::invalid_params("Amount must be positive"));
        }

        if self.to_address.is_zero() {
            return Err(EVMError::invalid_params("Recipient address cannot be zero"));
        }

        Ok(())
    }
}

/// Transfer action executor
pub struct TransferAction {
    provider: Arc<WalletProvider>,
}

impl TransferAction {
    /// Create a new transfer action
    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self { provider }
    }

    /// Execute a native token transfer
    pub async fn execute(&self, params: TransferParams) -> EVMResult<Transaction> {
        params.validate()?;

        let chain_provider = self.provider.provider(params.from_chain)?;
        let chain_id = params.from_chain.chain_id();
        let value = parse_amount(&params.amount, DEFAULT_DECIMALS)?;

        // Check balance
        let balance = self.provider.get_balance(params.from_chain).await?;
        if balance < value {
            return Err(EVMError::insufficient_funds(format!(
                "Insufficient balance: have {}, need {}",
                balance, value
            )));
        }

        // Build transaction request - fillers will handle nonce/gas/chain_id
        let mut tx = TransactionRequest::default()
            .with_to(params.to_address)
            .with_value(value);

        if let Some(data) = &params.data {
            tx = tx.with_input(data.clone());
        }

        // Send transaction (wallet filler handles signing)
        let pending = chain_provider
            .send_transaction(tx)
            .await
            .map_err(|e| {
                EVMError::new(
                    EVMErrorCode::TransactionFailed,
                    format!("Failed to send transaction: {e}"),
                )
            })?;

        let tx_hash = *pending.tx_hash();

        // Wait for confirmation
        let receipt = pending.get_receipt().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to get receipt: {e}"),
            )
        })?;

        if !receipt.status() {
            return Err(EVMError::new(
                EVMErrorCode::ContractRevert,
                format!("Transaction reverted: {tx_hash}"),
            ));
        }

        Ok(Transaction {
            hash: tx_hash,
            from: self.provider.address(),
            to: params.to_address,
            value,
            data: params.data,
            chain_id: Some(chain_id),
        })
    }

    /// Execute an ERC20 token transfer
    pub async fn execute_erc20(&self, params: TransferParams) -> EVMResult<Transaction> {
        let token_address = params.token.ok_or_else(|| {
            EVMError::invalid_params("Token address required for ERC20 transfer")
        })?;

        params.validate()?;

        let chain_provider = self.provider.provider(params.from_chain)?;
        let chain_id = params.from_chain.chain_id();
        let amount = parse_amount(&params.amount, DEFAULT_DECIMALS)?;

        // Encode ERC20 transfer(address,uint256) function call
        let mut calldata = Vec::with_capacity(68);
        calldata.extend_from_slice(&[0xa9, 0x05, 0x9c, 0xbb]);
        calldata.extend_from_slice(&[0u8; 12]);
        calldata.extend_from_slice(params.to_address.as_slice());
        calldata.extend_from_slice(&amount.to_be_bytes::<32>());

        let tx = TransactionRequest::default()
            .with_to(token_address)
            .with_input(Bytes::from(calldata));

        let pending = chain_provider
            .send_transaction(tx)
            .await
            .map_err(|e| {
                EVMError::new(
                    EVMErrorCode::TransactionFailed,
                    format!("Failed to send ERC20 transfer: {e}"),
                )
            })?;

        let tx_hash = *pending.tx_hash();

        let receipt = pending.get_receipt().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to get receipt: {e}"),
            )
        })?;

        if !receipt.status() {
            return Err(EVMError::new(
                EVMErrorCode::ContractRevert,
                format!("ERC20 transfer reverted: {tx_hash}"),
            ));
        }

        Ok(Transaction {
            hash: tx_hash,
            from: self.provider.address(),
            to: token_address,
            value: U256::ZERO,
            data: None,
            chain_id: Some(chain_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    #[test]
    fn test_transfer_params_validation() {
        let params = TransferParams::native(
            SupportedChain::Sepolia,
            address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
            "1.0",
        );

        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_invalid_amount() {
        let params = TransferParams::native(
            SupportedChain::Sepolia,
            address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
            "-1.0",
        );

        assert!(params.validate().is_err());
    }

    #[test]
    fn test_zero_address() {
        let params = TransferParams::native(SupportedChain::Sepolia, Address::ZERO, "1.0");

        assert!(params.validate().is_err());
    }
}
