#![allow(missing_docs)]

use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_ENCODING};
use reqwest::Client;
use std::time::Duration;

use crate::constants::{DEFAULT_CLOB_API_URL, DEFAULT_REQUEST_TIMEOUT_SECS, POLYGON_CHAIN_ID};
use crate::error::{PolymarketError, Result};
use crate::types::{
    ApiKey, ApiKeyCreds, BalanceAllowance, Market, MarketsResponse, OpenOrder, OrderBook,
    PriceHistoryEntry, SimplifiedMarketsResponse, TradesResponse,
};
use std::collections::HashMap;

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

        let key = private_key.strip_prefix("0x").unwrap_or(private_key);

        let signer: PrivateKeySigner = key
            .parse()
            .map_err(|e| PolymarketError::config_error(format!("Invalid private key: {e}")))?;

        let address = signer.address();

        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        // Avoid content-encoding variants we can't reliably decode everywhere.
        headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));

        let http = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS))
            .default_headers(headers)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
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
    // Balance Methods
    // =========================================================================

    /// Get collateral (USDC) balance
    pub async fn get_collateral_balance(&self) -> Result<BalanceAllowance> {
        let address = format!("{:?}", self.address);
        let url = format!("{}/balance?asset_type=COLLATERAL&address={}", self.base_url, address);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch collateral balance: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse balance response: {e}"))
        })
    }

    /// Get conditional token balance for a specific token
    ///
    /// # Arguments
    ///
    /// * `token_id` - The token ID
    pub async fn get_conditional_balance(&self, token_id: &str) -> Result<BalanceAllowance> {
        let address = format!("{:?}", self.address);
        let url = format!(
            "{}/balance?asset_type=CONDITIONAL&token_id={}&address={}",
            self.base_url, token_id, address
        );

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch conditional balance: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse balance response: {e}"))
        })
    }

    // =========================================================================
    // Trade Methods
    // =========================================================================

    /// Get trades for the authenticated user
    ///
    /// # Arguments
    ///
    /// * `market_id` - Optional market filter
    /// * `asset_ids` - Optional asset filter
    /// * `limit` - Maximum trades per page
    /// * `max_pages` - Maximum pages to fetch
    pub async fn get_trades(
        &self,
        market_id: Option<&str>,
        asset_ids: Option<&[String]>,
        limit: Option<u32>,
        max_pages: Option<u32>,
    ) -> Result<TradesResponse> {
        let address = format!("{:?}", self.address);
        let mut url = format!("{}/trades?maker_address={}", self.base_url, address);

        if let Some(market) = market_id {
            url.push_str(&format!("&market={}", market));
        }

        if let Some(assets) = asset_ids {
            for asset in assets {
                url.push_str(&format!("&asset_id={}", asset));
            }
        }

        if let Some(lim) = limit {
            url.push_str(&format!("&limit={}", lim));
        }

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch trades: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        let mut all_trades: TradesResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse trades response: {e}"))
        })?;

        // Handle pagination if needed
        let max_pages = max_pages.unwrap_or(1);
        let mut page = 1;

        while page < max_pages && !all_trades.next_cursor.is_empty() && all_trades.next_cursor != "LTE=" {
            let next_url = format!("{}&next_cursor={}", url, all_trades.next_cursor);
            let response = self.http.get(&next_url).send().await.map_err(|e| {
                PolymarketError::network_error(format!("Failed to fetch trades page: {e}"))
            })?;

            if !response.status().is_success() {
                break;
            }

            let page_response: TradesResponse = response.json().await.map_err(|e| {
                PolymarketError::api_error(format!("Failed to parse trades page: {e}"))
            })?;

            all_trades.data.extend(page_response.data);
            all_trades.next_cursor = page_response.next_cursor;
            page += 1;
        }

        Ok(all_trades)
    }

    // =========================================================================
    // Price History Methods
    // =========================================================================

    /// Get price history for a token
    ///
    /// # Arguments
    ///
    /// * `token_id` - The token ID
    /// * `start_ts` - Start timestamp (Unix seconds)
    /// * `end_ts` - End timestamp (Unix seconds)
    /// * `fidelity` - Time interval in minutes
    pub async fn get_price_history(
        &self,
        token_id: &str,
        start_ts: Option<i64>,
        end_ts: Option<i64>,
        fidelity: Option<u32>,
    ) -> Result<Vec<PriceHistoryEntry>> {
        let mut url = format!("{}/prices-history?market={}", self.base_url, token_id);

        if let Some(start) = start_ts {
            url.push_str(&format!("&startTs={}", start));
        }

        if let Some(end) = end_ts {
            url.push_str(&format!("&endTs={}", end));
        }

        if let Some(fid) = fidelity {
            url.push_str(&format!("&fidelity={}", fid));
        }

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch price history: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct PriceHistoryResponse {
            history: Vec<PriceHistoryEntry>,
        }

        let data: PriceHistoryResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse price history response: {e}"))
        })?;

        Ok(data.history)
    }

    // =========================================================================
    // Order Methods
    // =========================================================================

    /// Get order details by order ID
    ///
    /// # Arguments
    ///
    /// * `order_id` - The order ID
    pub async fn get_order(&self, order_id: &str) -> Result<OpenOrder> {
        let url = format!("{}/order/{}", self.base_url, order_id);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch order: {e}"))
        })?;

        if !response.status().is_success() {
            if response.status().as_u16() == 404 {
                return Err(PolymarketError::invalid_order(format!(
                    "Order not found: {order_id}"
                )));
            }
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse order response: {e}"))
        })
    }

    /// Get open orders for the authenticated user
    ///
    /// # Arguments
    ///
    /// * `market_id` - Optional market filter
    /// * `asset_id` - Optional asset filter
    pub async fn get_orders(
        &self,
        market_id: Option<&str>,
        asset_id: Option<&str>,
    ) -> Result<Vec<OpenOrder>> {
        let address = format!("{:?}", self.address);
        let mut url = format!("{}/orders?maker_address={}", self.base_url, address);

        if let Some(market) = market_id {
            url.push_str(&format!("&market={}", market));
        }

        if let Some(asset) = asset_id {
            url.push_str(&format!("&asset_id={}", asset));
        }

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch orders: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse orders response: {e}"))
        })
    }

    /// Check if orders are scoring (eligible for rewards)
    ///
    /// # Arguments
    ///
    /// * `order_ids` - List of order IDs to check
    pub async fn check_order_scoring(&self, order_ids: &[String]) -> Result<HashMap<String, bool>> {
        let ids_param = order_ids.join(",");
        let url = format!("{}/order-scoring?order_ids={}", self.base_url, ids_param);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to check order scoring: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct ScoringResponse {
            scoring: HashMap<String, bool>,
        }

        let data: ScoringResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse scoring response: {e}"))
        })?;

        Ok(data.scoring)
    }

    // =========================================================================
    // API Key Methods
    // =========================================================================

    /// Get all API keys for the authenticated user
    pub async fn get_api_keys(&self) -> Result<Vec<ApiKey>> {
        let address = format!("{:?}", self.address);
        let url = format!("{}/api-keys?address={}", self.base_url, address);

        let response = self.http.get(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to fetch API keys: {e}"))
        })?;

        if !response.status().is_success() {
            return Err(PolymarketError::api_error(format!(
                "API returned error: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct ApiKeysResponse {
            api_keys: Vec<ApiKey>,
        }

        let data: ApiKeysResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse API keys response: {e}"))
        })?;

        Ok(data.api_keys)
    }

    /// Revoke an API key
    ///
    /// # Arguments
    ///
    /// * `key_id` - The API key ID to revoke
    pub async fn revoke_api_key(&self, key_id: &str) -> Result<bool> {
        let url = format!("{}/api-keys/{}", self.base_url, key_id);

        let response = self.http.delete(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to revoke API key: {e}"))
        })?;

        Ok(response.status().is_success())
    }

    // =========================================================================
    // Order Placement Methods
    // =========================================================================

    /// Post a signed order to the CLOB API
    ///
    /// # Arguments
    ///
    /// * `signed_order` - The signed order to submit
    pub async fn post_order(
        &self,
        signed_order: &crate::actions::SignedOrder,
    ) -> Result<crate::types::OrderResponse> {
        let url = format!("{}/order", self.base_url);

        let response = self
            .http
            .post(&url)
            .json(signed_order)
            .send()
            .await
            .map_err(|e| PolymarketError::network_error(format!("Failed to post order: {e}")))?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(PolymarketError::api_error(format!(
                "Failed to post order ({}): {}",
                status, error_text
            )));
        }

        response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse order response: {e}"))
        })
    }

    /// Cancel an order
    ///
    /// # Arguments
    ///
    /// * `order_id` - The order ID to cancel
    pub async fn cancel_order(&self, order_id: &str) -> Result<bool> {
        let url = format!("{}/order/{}", self.base_url, order_id);

        let response = self.http.delete(&url).send().await.map_err(|e| {
            PolymarketError::network_error(format!("Failed to cancel order: {e}"))
        })?;

        Ok(response.status().is_success())
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
