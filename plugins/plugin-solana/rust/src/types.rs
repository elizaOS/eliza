#![allow(missing_docs)]

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioItem {
    pub name: String,
    pub address: String,
    pub symbol: String,
    pub decimals: u8,
    pub balance: String,
    pub ui_amount: String,
    pub price_usd: String,
    pub value_usd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_sol: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prices {
    pub solana: PriceInfo,
    pub bitcoin: PriceInfo,
    pub ethereum: PriceInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceInfo {
    pub usd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletPortfolio {
    pub total_usd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_sol: Option<String>,
    pub items: Vec<PortfolioItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prices: Option<Prices>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAccountInfo {
    pub mint: String,
    pub owner: String,
    pub amount: String,
    pub decimals: u8,
    pub ui_amount: Decimal,
}

#[derive(Debug, Clone)]
pub struct TransferParams {
    pub recipient: Pubkey,
    pub amount: Decimal,
    pub mint: Option<Pubkey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub amount: String,
    pub recipient: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuoteParams {
    pub input_mint: String,
    pub output_mint: String,
    pub amount: String,
    #[serde(default = "default_slippage")]
    pub slippage_bps: u16,
}

fn default_slippage() -> u16 {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapQuote {
    pub input_mint: String,
    pub in_amount: String,
    pub output_mint: String,
    pub out_amount: String,
    pub other_amount_threshold: String,
    pub swap_mode: String,
    pub slippage_bps: u16,
    pub price_impact_pct: String,
    pub route_plan: Vec<RoutePlanStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutePlanStep {
    pub swap_info: SwapInfo,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapInfo {
    pub amm_key: String,
    pub label: String,
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub fee_amount: String,
    pub fee_mint: String,
}

#[derive(Debug, Clone)]
pub struct SwapExecuteParams {
    pub quote: SwapQuote,
    pub user_pubkey: Pubkey,
    pub wrap_unwrap_sol: bool,
    pub priority_fee_lamports: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapTransaction {
    pub swap_transaction: String,
    pub last_valid_block_height: u64,
    #[serde(default)]
    pub prioritization_fee_lamports: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BirdeyePriceResponse {
    pub success: bool,
    pub data: BirdeyePriceData,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BirdeyePriceData {
    pub value: f64,
    pub update_unix_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSupply {
    pub amount: String,
    pub decimals: u8,
    pub ui_amount: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResult {
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
