#![allow(missing_docs)]

use alloy::{
    hex,
    network::TransactionBuilder,
    primitives::{Address, Bytes, U256},
    providers::Provider,
    rpc::types::TransactionRequest,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::constants::{DEFAULT_SLIPPAGE_PERCENT, LIFI_API_URL};
use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{SupportedChain, Transaction};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapParams {
    pub chain: SupportedChain,
    pub from_token: Address,
    pub to_token: Address,
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slippage: Option<f64>,
}

impl SwapParams {
    #[must_use]
    pub fn new(
        chain: SupportedChain,
        from_token: Address,
        to_token: Address,
        amount: impl Into<String>,
    ) -> Self {
        Self {
            chain,
            from_token,
            to_token,
            amount: amount.into(),
            slippage: None,
        }
    }

    #[must_use]
    pub fn with_slippage(mut self, slippage: f64) -> Self {
        self.slippage = Some(slippage);
        self
    }

    #[must_use]
    pub fn slippage_or_default(&self) -> f64 {
        self.slippage.unwrap_or(DEFAULT_SLIPPAGE_PERCENT)
    }

    pub fn validate(&self) -> EVMResult<()> {
        if self.amount.is_empty() {
            return Err(EVMError::invalid_params("Amount is required"));
        }

        if self.from_token == self.to_token {
            return Err(EVMError::invalid_params(
                "From and to tokens must be different",
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapQuote {
    pub aggregator: String,
    pub min_output_amount: String,
    pub to: Address,
    pub value: U256,
    pub data: Bytes,
    pub gas_limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct LifiQuoteResponse {
    estimate: LifiEstimate,
    #[serde(rename = "transactionRequest")]
    transaction_request: LifiTransactionRequest,
}

#[derive(Debug, Deserialize)]
struct LifiEstimate {
    #[serde(rename = "toAmountMin")]
    to_amount_min: String,
}

#[derive(Debug, Deserialize)]
struct LifiTransactionRequest {
    to: String,
    value: String,
    data: String,
    #[serde(rename = "gasLimit")]
    gas_limit: Option<String>,
}

pub struct SwapAction {
    provider: Arc<WalletProvider>,
    http_client: reqwest::Client,
}

impl SwapAction {
    /// elizaOS Action name (TS parity).
    pub const NAME: &'static str = "EVM_SWAP_TOKENS";

    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self {
            provider,
            http_client: reqwest::Client::new(),
        }
    }

    pub async fn get_quote(&self, params: &SwapParams) -> EVMResult<SwapQuote> {
        params.validate()?;

        let from_address = self.provider.address();
        let chain_id = params.chain.chain_id();

        let url = format!(
            "{}/quote?fromChain={}&toChain={}&fromToken={}&toToken={}&fromAmount={}&fromAddress={}&slippage={}",
            LIFI_API_URL,
            chain_id,
            chain_id,
            params.from_token,
            params.to_token,
            params.amount,
            from_address,
            params.slippage_or_default()
        );

        let response = self
            .http_client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(EVMError::new(
                EVMErrorCode::RouteNotFound,
                format!("LiFi API error ({}): {}", status, body),
            ));
        }

        let quote_response: LifiQuoteResponse = response.json().await?;
        let tx_request = quote_response.transaction_request;

        let to: Address = tx_request
            .to
            .parse()
            .map_err(|_| EVMError::invalid_params("Invalid to address in quote"))?;

        let value = U256::from_str_radix(tx_request.value.trim_start_matches("0x"), 16)
            .unwrap_or(U256::ZERO);

        let data = Bytes::from(
            hex::decode(tx_request.data.trim_start_matches("0x"))
                .map_err(|e| EVMError::invalid_params(format!("Invalid data in quote: {e}")))?,
        );

        let gas_limit = tx_request.gas_limit.as_ref().and_then(|g| g.parse().ok());

        Ok(SwapQuote {
            aggregator: "lifi".to_string(),
            min_output_amount: quote_response.estimate.to_amount_min,
            to,
            value,
            data,
            gas_limit,
        })
    }

    pub async fn execute(&self, params: SwapParams) -> EVMResult<Transaction> {
        params.validate()?;

        let quote = self.get_quote(&params).await?;
        let chain_id = params.chain.chain_id();
        let chain_provider = self.provider.provider(params.chain)?;

        let mut tx = TransactionRequest::default()
            .with_to(quote.to)
            .with_value(quote.value)
            .with_input(quote.data.clone());

        if let Some(gas_limit) = quote.gas_limit {
            tx = tx.with_gas_limit(gas_limit);
        }

        let pending = chain_provider.send_transaction(tx).await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to send swap transaction: {e}"),
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
                format!("Swap transaction reverted: {tx_hash}"),
            ));
        }

        Ok(Transaction {
            hash: tx_hash,
            from: self.provider.address(),
            to: quote.to,
            value: quote.value,
            data: Some(quote.data),
            chain_id: Some(chain_id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    #[test]
    fn test_swap_params_validation() {
        let params = SwapParams::new(
            SupportedChain::Mainnet,
            address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), // WETH
            address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), // USDC
            "1000000000000000000",
        );

        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_same_token_error() {
        let weth = address!("C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
        let params = SwapParams::new(SupportedChain::Mainnet, weth, weth, "1000000000000000000");

        assert!(params.validate().is_err());
    }
}
