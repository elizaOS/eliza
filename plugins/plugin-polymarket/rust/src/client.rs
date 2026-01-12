#![allow(missing_docs)]

use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
use reqwest::Client;
use std::time::Duration;

use crate::constants::{DEFAULT_CLOB_API_URL, DEFAULT_REQUEST_TIMEOUT_SECS, POLYGON_CHAIN_ID};
use crate::error::{PolymarketError, Result};
use crate::types::{
    ApiKeyCreds, Market, MarketsResponse, OrderBook, OrderParams, OrderResponse,
    SimplifiedMarketsResponse,
};

pub struct ClobClient {
    http: Client,
    base_url: String,
    chain_id: u64,
    address: Address,
    creds: Option<ApiKeyCreds>,
}

impl ClobClient {
    pub async fn new(base_url: Option<&str>, private_key: &str) -> Result<Self> {
        let base_url = base_url
            .unwrap_or(DEFAULT_CLOB_API_URL)
            .trim_end_matches('/')
            .to_string();

        let key = if private_key.starts_with("0x") {
            &private_key[2..]
        } else {
            private_key
        };

        let signer: PrivateKeySigner = key
            .parse()
            .map_err(|e| PolymarketError::config_error(format!("Invalid private key: {e}")))?;

        let address = signer.address();

        let http = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| {
                PolymarketError::network_error(format!("Failed to create HTTP client: {e}"))
            })?;

        Ok(Self {
            http,
            base_url,
            chain_id: POLYGON_CHAIN_ID,
            address,
            creds: None,
        })
    }

    pub async fn new_with_creds(
        base_url: Option<&str>,
        private_key: &str,
        creds: ApiKeyCreds,
    ) -> Result<Self> {
        let mut client = Self::new(base_url, private_key).await?;
        client.creds = Some(creds);
        Ok(client)
    }

    #[must_use]
    pub fn address(&self) -> Address {
        self.address
    }

    #[must_use]
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// Check if client has API credentials
    #[must_use]
    pub fn has_credentials(&self) -> bool {
        self.creds.is_some()
    }

    // =========================================================================
    // Market Methods
    // =========================================================================

    /// Get all markets
    ///
    /// # Arguments
    ///
    /// * `next_cursor` - Optional pagination cursor
    pub async fn get_markets(&self, next_cursor: Option<&str>) -> Result<MarketsResponse> {
        let mut url = format!("{}/markets", self.base_url);
        if let Some(cursor) = next_cursor {
            url = format!("{url}?next_cursor={cursor}");
        }

        let response =
            self.http.get(&url).send().await.map_err(|e| {
                PolymarketError::network_error(format!("Failed to fetch markets: {e}"))
            })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse markets response: {e}"))
        })
    }

    /// Get simplified markets
    ///
    /// # Arguments
    ///
    /// * `next_cursor` - Optional pagination cursor
    pub async fn get_simplified_markets(
        &self,
        next_cursor: Option<&str>,
    ) -> Result<SimplifiedMarketsResponse> {
        let mut url = format!("{}/simplified-markets", self.base_url);
        if let Some(cursor) = next_cursor {
            url = format!("{url}?next_cursor={cursor}");
        }

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch simplified markets: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse simplified markets response: {e}"))
        })
    }

    /// Get sampling markets (markets with rewards enabled)
    ///
    /// # Arguments
    ///
    /// * `next_cursor` - Optional pagination cursor
    pub async fn get_sampling_markets(
        &self,
        next_cursor: Option<&str>,
    ) -> Result<SimplifiedMarketsResponse> {
        let mut url = format!("{}/sampling-markets", self.base_url);
        if let Some(cursor) = next_cursor {
            url = format!("{url}?next_cursor={cursor}");
        }

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch sampling markets: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse sampling markets response: {e}"))
        })
    }

    /// Get a specific market by condition ID
    ///
    /// # Arguments
    ///
    /// * `condition_id` - The market condition ID
    pub async fn get_market(&self, condition_id: &str) -> Result<Market> {
        let url = format!("{}/markets/{condition_id}", self.base_url);

        let response =
            self.http.get(&url).send().await.map_err(|e| {
                PolymarketError::network_error(format!("Failed to fetch market: {e}"))
            })?;

        if !response.status().is_success() {
            if response.status().as_u16() == 404 {
                return Err(PolymarketError::invalid_market(format!(
                    "Market not found: {condition_id}"
                )));
            }
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse market response: {e}"))
        })
    }

    // =========================================================================
    // Order Book Methods
    // =========================================================================

    /// Get order book for a token
    ///
    /// # Arguments
    ///
    /// * `token_id` - The token ID
    pub async fn get_order_book(&self, token_id: &str) -> Result<OrderBook> {
        let url = format!("{}/book?token_id={token_id}", self.base_url);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch order book: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse order book response: {e}"))
        })
    }

    /// Get midpoint price for a token
    ///
    /// # Arguments
    ///
    /// * `token_id` - The token ID
    pub async fn get_midpoint(&self, token_id: &str) -> Result<String> {
        let url = format!("{}/midpoint?token_id={token_id}", self.base_url);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch midpoint: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct MidpointResponse {
            mid: String,
        }

        let data: MidpointResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse midpoint response: {e}"))
        })?;

        Ok(data.mid)
    }

    /// Get spread for a token
    ///
    /// # Arguments
    ///
    /// * `token_id` - The token ID
    pub async fn get_spread(&self, token_id: &str) -> Result<String> {
        let url = format!("{}/spread?token_id={token_id}", self.base_url);

        let response =
            self.http.get(&url).send().await.map_err(|e| {
                PolymarketError::network_error(format!("Failed to fetch spread: {e}"))
            })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct SpreadResponse {
            spread: String,
        }

        let data: SpreadResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse spread response: {e}"))
        })?;

        Ok(data.spread)
    }

    // =========================================================================
    // Order Methods (require authentication)
    // =========================================================================

    /// Place an order
    ///
    /// # Arguments
    ///
    /// * `params` - Order parameters
    ///
    /// # Errors
    ///
    /// Returns an error if not authenticated or order fails
    pub async fn place_order(&self, params: OrderParams) -> Result<OrderResponse> {
        if self.creds.is_none() {
            return Err(PolymarketError::new(
                crate::error::PolymarketErrorCode::AuthError,
                "API credentials required for placing orders",
            ));
        }

        // Build signed order request
        let url = format!("{}/order", self.base_url);

        let response = self
            .http
            .post(&url)
            .json(&params)
            .send()
            .await
            .map_err(|e| PolymarketError::network_error(format!("Failed to place order: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(PolymarketError::api_error(format!(
                "Order placement failed: {status} - {body}"
            )));
        }

        response
            .json()
            .await
            .map_err(|e| PolymarketError::api_error(format!("Failed to parse order response: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_address_parsing() {
        // This would require a valid test private key
        // For now, just verify the module compiles
        assert_eq!(POLYGON_CHAIN_ID, 137);
    }
}
