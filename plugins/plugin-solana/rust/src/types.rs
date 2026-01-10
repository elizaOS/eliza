//! Type definitions for Solana plugin operations.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;

/// Token item in a wallet portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioItem {
    /// Token name.
    pub name: String,
    /// Token mint address.
    pub address: String,
    /// Token symbol.
    pub symbol: String,
    /// Token decimals.
    pub decimals: u8,
    /// Raw balance as string.
    pub balance: String,
    /// UI-friendly amount.
    pub ui_amount: String,
    /// Price in USD.
    pub price_usd: String,
    /// Value in USD.
    pub value_usd: String,
    /// Value in SOL (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_sol: Option<String>,
}

/// Price information for major cryptocurrencies.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prices {
    /// Solana price.
    pub solana: PriceInfo,
    /// Bitcoin price.
    pub bitcoin: PriceInfo,
    /// Ethereum price.
    pub ethereum: PriceInfo,
}

/// Price information for a single cryptocurrency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceInfo {
    /// Price in USD.
    pub usd: String,
}

/// Complete wallet portfolio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPortfolio {
    /// Total value in USD.
    pub total_usd: String,
    /// Total value in SOL (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_sol: Option<String>,
    /// List of token holdings.
    pub items: Vec<PortfolioItem>,
    /// Market prices (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prices: Option<Prices>,
    /// Last update timestamp in milliseconds (optional).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<u64>,
}

/// Token account information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAccountInfo {
    /// Mint address.
    pub mint: String,
    /// Owner address.
    pub owner: String,
    /// Raw amount as string.
    pub amount: String,
    /// Decimals.
    pub decimals: u8,
    /// UI amount.
    pub ui_amount: Decimal,
}

/// Parameters for a token transfer.
#[derive(Debug, Clone)]
pub struct TransferParams {
    /// Recipient address.
    pub recipient: Pubkey,
    /// Amount to transfer (in UI units for tokens, SOL for native).
    pub amount: Decimal,
    /// Token mint address (None for SOL transfer).
    pub mint: Option<Pubkey>,
}

/// Result of a transfer operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    /// Whether the transfer was successful.
    pub success: bool,
    /// Transaction signature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Amount transferred.
    pub amount: String,
    /// Recipient address.
    pub recipient: String,
    /// Error message if failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Parameters for getting a swap quote.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuoteParams {
    /// Input token mint address.
    pub input_mint: String,
    /// Output token mint address.
    pub output_mint: String,
    /// Amount in base units.
    pub amount: String,
    /// Slippage in basis points (100 = 1%).
    #[serde(default = "default_slippage")]
    pub slippage_bps: u16,
}

fn default_slippage() -> u16 {
    50 // 0.5% default
}

/// Jupiter swap quote response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuote {
    /// Input token mint.
    pub input_mint: String,
    /// Input amount in base units.
    pub in_amount: String,
    /// Output token mint.
    pub output_mint: String,
    /// Output amount in base units.
    pub out_amount: String,
    /// Minimum output amount after slippage.
    pub other_amount_threshold: String,
    /// Swap mode (ExactIn or ExactOut).
    pub swap_mode: String,
    /// Slippage in basis points.
    pub slippage_bps: u16,
    /// Price impact percentage.
    pub price_impact_pct: String,
    /// Route plan.
    pub route_plan: Vec<RoutePlanStep>,
}

/// A step in the swap route.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlanStep {
    /// Swap info for this step.
    pub swap_info: SwapInfo,
    /// Percentage of input routed through this step.
    pub percent: u8,
}

/// Swap information for a route step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    /// AMM key.
    pub amm_key: String,
    /// DEX label.
    pub label: String,
    /// Input mint.
    pub input_mint: String,
    /// Output mint.
    pub output_mint: String,
    /// Input amount.
    pub in_amount: String,
    /// Output amount.
    pub out_amount: String,
    /// Fee amount.
    pub fee_amount: String,
    /// Fee mint.
    pub fee_mint: String,
}

/// Parameters for executing a swap.
#[derive(Debug, Clone)]
pub struct SwapExecuteParams {
    /// The quote to execute.
    pub quote: SwapQuote,
    /// User's public key.
    pub user_pubkey: Pubkey,
    /// Whether to wrap/unwrap SOL automatically.
    pub wrap_unwrap_sol: bool,
    /// Priority fee in micro-lamports (optional).
    pub priority_fee_lamports: Option<u64>,
}

/// Result of a swap execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// Whether the swap was successful.
    pub success: bool,
    /// Transaction signature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Input amount.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_amount: Option<String>,
    /// Output amount.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_amount: Option<String>,
    /// Error message if failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Jupiter swap transaction response.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapTransaction {
    /// Base64-encoded versioned transaction.
    pub swap_transaction: String,
    /// Last valid block height.
    pub last_valid_block_height: u64,
    /// Prioritization fee in lamports.
    #[serde(default)]
    pub prioritization_fee_lamports: u64,
}

/// Birdeye price response.
#[derive(Debug, Clone, Deserialize)]
pub struct BirdeyePriceResponse {
    /// Whether the request was successful.
    pub success: bool,
    /// Price data.
    pub data: BirdeyePriceData,
}

/// Birdeye price data.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirdeyePriceData {
    /// Token price in USD.
    pub value: f64,
    /// Update timestamp.
    pub update_unix_time: u64,
}

/// Token supply information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSupply {
    /// Raw supply.
    pub amount: String,
    /// Decimals.
    pub decimals: u8,
    /// UI amount.
    pub ui_amount: Decimal,
}

/// Balance query result for multiple addresses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResult {
    /// Address to balance mapping (in SOL, not lamports).
    pub balances: std::collections::HashMap<String, Decimal>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_portfolio_item_serialization() {
        let item = PortfolioItem {
            name: "Solana".to_string(),
            address: "So11111111111111111111111111111111111111112".to_string(),
            symbol: "SOL".to_string(),
            decimals: 9,
            balance: "1000000000".to_string(),
            ui_amount: "1.0".to_string(),
            price_usd: "150.00".to_string(),
            value_usd: "150.00".to_string(),
            value_sol: Some("1.0".to_string()),
        };

        let json = serde_json::to_string(&item).expect("serialization should succeed");
        assert!(json.contains("\"name\":\"Solana\""));
        assert!(json.contains("\"symbol\":\"SOL\""));
    }

    #[test]
    fn test_swap_quote_params_default_slippage() {
        let json = r#"{"inputMint":"So11","outputMint":"EPj","amount":"1000"}"#;
        let params: SwapQuoteParams = serde_json::from_str(json).expect("parse should succeed");
        assert_eq!(params.slippage_bps, 50);
    }
}


