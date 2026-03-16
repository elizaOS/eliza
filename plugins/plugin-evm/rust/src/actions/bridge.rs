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
use std::time::Duration;

use crate::constants::{
    BRIDGE_POLL_INTERVAL_SECS, DEFAULT_SLIPPAGE_PERCENT, LIFI_API_URL, MAX_BRIDGE_POLL_ATTEMPTS,
    MAX_PRICE_IMPACT,
};
use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::providers::WalletProvider;
use crate::types::{SupportedChain, Transaction};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeParams {
    pub from_chain: SupportedChain,
    pub to_chain: SupportedChain,
    pub from_token: Address,
    pub to_token: Address,
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_address: Option<Address>,
}

impl BridgeParams {
    #[must_use]
    pub fn new(
        from_chain: SupportedChain,
        to_chain: SupportedChain,
        from_token: Address,
        to_token: Address,
        amount: impl Into<String>,
    ) -> Self {
        Self {
            from_chain,
            to_chain,
            from_token,
            to_token,
            amount: amount.into(),
            to_address: None,
        }
    }

    #[must_use]
    pub fn with_recipient(mut self, address: Address) -> Self {
        self.to_address = Some(address);
        self
    }

    pub fn validate(&self) -> EVMResult<()> {
        if self.amount.is_empty() {
            return Err(EVMError::invalid_params("Amount is required"));
        }

        if self.from_chain == self.to_chain {
            return Err(EVMError::invalid_params(
                "Source and destination chains must be different",
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub status: BridgeStatusType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub substatus: Option<String>,
    pub source_tx_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest_tx_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum BridgeStatusType {
    Pending,
    Done,
    Failed,
}

#[derive(Debug, Deserialize)]
struct LifiRoutesResponse {
    routes: Vec<LifiRoute>,
}

#[derive(Debug, Deserialize)]
struct LifiRoute {
    steps: Vec<LifiStep>,
    #[serde(rename = "fromChainId")]
    from_chain_id: u64,
    #[serde(rename = "toChainId")]
    to_chain_id: u64,
}

#[derive(Debug, Deserialize)]
struct LifiStep {
    tool: String,
    #[serde(rename = "transactionRequest")]
    transaction_request: Option<LifiTransactionRequest>,
}

#[derive(Debug, Deserialize)]
struct LifiTransactionRequest {
    to: String,
    value: String,
    data: String,
    #[serde(rename = "gasLimit")]
    gas_limit: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LifiStatusResponse {
    status: String,
    substatus: Option<String>,
    #[serde(rename = "receiving")]
    receiving: Option<LifiReceiving>,
}

#[derive(Debug, Deserialize)]
struct LifiReceiving {
    #[serde(rename = "txHash")]
    tx_hash: Option<String>,
}

pub struct BridgeAction {
    provider: Arc<WalletProvider>,
    http_client: reqwest::Client,
}

impl BridgeAction {
    /// elizaOS Action name (TS parity).
    pub const NAME: &'static str = "EVM_BRIDGE_TOKENS";

    #[must_use]
    pub fn new(provider: Arc<WalletProvider>) -> Self {
        Self {
            provider,
            http_client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    async fn get_routes(&self, params: &BridgeParams) -> EVMResult<LifiRoutesResponse> {
        let from_address = self.provider.address();
        let to_address = params.to_address.unwrap_or(from_address);

        let url = format!(
            "{}/routes?fromChainId={}&toChainId={}&fromTokenAddress={}&toTokenAddress={}&fromAmount={}&fromAddress={}&toAddress={}&options={{\"slippage\":{},\"maxPriceImpact\":{}}}",
            LIFI_API_URL,
            params.from_chain.chain_id(),
            params.to_chain.chain_id(),
            params.from_token,
            params.to_token,
            params.amount,
            from_address,
            to_address,
            DEFAULT_SLIPPAGE_PERCENT,
            MAX_PRICE_IMPACT,
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

        response.json().await.map_err(Into::into)
    }

    async fn poll_status(
        &self,
        tx_hash: &str,
        from_chain_id: u64,
        to_chain_id: u64,
        tool: &str,
    ) -> EVMResult<BridgeStatus> {
        for attempt in 1..=MAX_BRIDGE_POLL_ATTEMPTS {
            tokio::time::sleep(Duration::from_secs(BRIDGE_POLL_INTERVAL_SECS)).await;

            let url = format!(
                "{}/status?txHash={}&fromChain={}&toChain={}&bridge={}",
                LIFI_API_URL, tx_hash, from_chain_id, to_chain_id, tool
            );

            let response = self
                .http_client
                .get(&url)
                .header("Accept", "application/json")
                .send()
                .await;

            match response {
                Ok(resp) if resp.status().is_success() => {
                    let status_response: LifiStatusResponse = resp.json().await?;

                    let status_type = match status_response.status.as_str() {
                        "DONE" => BridgeStatusType::Done,
                        "FAILED" => BridgeStatusType::Failed,
                        _ => BridgeStatusType::Pending,
                    };

                    let dest_tx_hash = status_response.receiving.and_then(|r| r.tx_hash);

                    if status_type != BridgeStatusType::Pending {
                        return Ok(BridgeStatus {
                            status: status_type,
                            substatus: status_response.substatus,
                            source_tx_hash: tx_hash.to_string(),
                            dest_tx_hash,
                        });
                    }

                    tracing::debug!(
                        "Bridge poll attempt {}/{}: {}",
                        attempt,
                        MAX_BRIDGE_POLL_ATTEMPTS,
                        status_response.status
                    );
                }
                Ok(resp) => {
                    tracing::warn!("Status check failed with code: {}", resp.status());
                }
                Err(e) => {
                    tracing::warn!("Status check error: {}", e);
                }
            }
        }

        Ok(BridgeStatus {
            status: BridgeStatusType::Pending,
            substatus: Some("Status polling timed out".to_string()),
            source_tx_hash: tx_hash.to_string(),
            dest_tx_hash: None,
        })
    }

    pub async fn execute(&self, params: BridgeParams) -> EVMResult<(Transaction, BridgeStatus)> {
        params.validate()?;

        self.provider.provider(params.from_chain)?;
        self.provider.provider(params.to_chain)?;

        let chain_provider = self.provider.provider(params.from_chain)?;
        let chain_id = params.from_chain.chain_id();
        let routes = self.get_routes(&params).await?;

        let route = routes
            .routes
            .first()
            .ok_or_else(|| EVMError::new(EVMErrorCode::RouteNotFound, "No bridge routes found"))?;

        let step = route
            .steps
            .first()
            .ok_or_else(|| EVMError::new(EVMErrorCode::RouteNotFound, "No bridge steps found"))?;

        let tx_request = step.transaction_request.as_ref().ok_or_else(|| {
            EVMError::new(
                EVMErrorCode::RouteNotFound,
                "No transaction request in route",
            )
        })?;

        let to: Address = tx_request
            .to
            .parse()
            .map_err(|_| EVMError::invalid_params("Invalid to address in route"))?;

        let value = U256::from_str_radix(tx_request.value.trim_start_matches("0x"), 16)
            .unwrap_or(U256::ZERO);

        let data = Bytes::from(
            hex::decode(tx_request.data.trim_start_matches("0x"))
                .map_err(|e| EVMError::invalid_params(format!("Invalid data in route: {e}")))?,
        );

        let gas_limit: Option<u64> = tx_request.gas_limit.as_ref().and_then(|g| g.parse().ok());

        let mut tx = TransactionRequest::default()
            .with_to(to)
            .with_value(value)
            .with_input(data.clone());

        if let Some(limit) = gas_limit {
            tx = tx.with_gas_limit(limit);
        }

        let pending = chain_provider.send_transaction(tx).await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to send bridge transaction: {e}"),
            )
        })?;

        let tx_hash = *pending.tx_hash();
        let tx_hash_str = format!("{tx_hash:#x}");
        let receipt = pending.get_receipt().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::TransactionFailed,
                format!("Failed to get receipt: {e}"),
            )
        })?;

        if !receipt.status() {
            return Err(EVMError::new(
                EVMErrorCode::ContractRevert,
                format!("Bridge transaction reverted: {tx_hash}"),
            ));
        }

        tracing::info!("Bridge source transaction confirmed: {}", tx_hash);

        let bridge_status = self
            .poll_status(
                &tx_hash_str,
                route.from_chain_id,
                route.to_chain_id,
                &step.tool,
            )
            .await?;

        let transaction = Transaction {
            hash: tx_hash,
            from: self.provider.address(),
            to,
            value,
            data: Some(data),
            chain_id: Some(chain_id),
        };

        Ok((transaction, bridge_status))
    }

    pub async fn check_status(
        &self,
        tx_hash: &str,
        from_chain: SupportedChain,
        to_chain: SupportedChain,
        tool: &str,
    ) -> EVMResult<BridgeStatus> {
        let url = format!(
            "{}/status?txHash={}&fromChain={}&toChain={}&bridge={}",
            LIFI_API_URL,
            tx_hash,
            from_chain.chain_id(),
            to_chain.chain_id(),
            tool
        );

        let response = self
            .http_client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(EVMError::network_error("Failed to get bridge status"));
        }

        let status_response: LifiStatusResponse = response.json().await?;

        let status_type = match status_response.status.as_str() {
            "DONE" => BridgeStatusType::Done,
            "FAILED" => BridgeStatusType::Failed,
            _ => BridgeStatusType::Pending,
        };

        Ok(BridgeStatus {
            status: status_type,
            substatus: status_response.substatus,
            source_tx_hash: tx_hash.to_string(),
            dest_tx_hash: status_response.receiving.and_then(|r| r.tx_hash),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    #[test]
    fn test_bridge_params_validation() {
        let native = Address::ZERO;
        let params = BridgeParams::new(
            SupportedChain::Mainnet,
            SupportedChain::Base,
            native,
            native,
            "1000000000000000000",
        );

        assert!(params.validate().is_ok());
    }

    #[test]
    fn test_same_chain_error() {
        let native = Address::ZERO;
        let params = BridgeParams::new(
            SupportedChain::Mainnet,
            SupportedChain::Mainnet,
            native,
            native,
            "1000000000000000000",
        );

        assert!(params.validate().is_err());
    }

    #[test]
    fn test_bridge_with_recipient() {
        let native = Address::ZERO;
        let recipient = address!("d8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        let params = BridgeParams::new(
            SupportedChain::Mainnet,
            SupportedChain::Base,
            native,
            native,
            "1000000000000000000",
        )
        .with_recipient(recipient);

        assert_eq!(params.to_address, Some(recipient));
    }
}
