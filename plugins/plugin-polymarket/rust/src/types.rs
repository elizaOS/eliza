#![allow(missing_docs)]
//! Type definitions for the Polymarket plugin
//!
//! This module provides strongly typed definitions for all Polymarket operations.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    pub token_id: String,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rewards {
    pub min_size: f64,
    pub max_spread: f64,
    pub event_start_date: String,
    pub event_end_date: String,
    pub in_game_multiplier: f64,
    pub reward_epoch: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub condition_id: String,
    pub question_id: String,
    pub tokens: (Token, Token),
    pub rewards: Rewards,
    pub minimum_order_size: String,
    pub minimum_tick_size: String,
    pub category: String,
    pub end_date_iso: String,
    pub game_start_time: String,
    pub question: String,
    pub market_slug: String,
    pub min_incentive_size: String,
    pub max_incentive_spread: String,
    pub active: bool,
    pub closed: bool,
    pub seconds_delay: i64,
    pub icon: String,
    pub fpmm: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimplifiedMarket {
    pub condition_id: String,
    pub tokens: (Token, Token),
    pub rewards: Rewards,
    pub min_incentive_size: String,
    pub max_incentive_spread: String,
    pub active: bool,
    pub closed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl fmt::Display for OrderSide {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Buy => write!(f, "BUY"),
            Self::Sell => write!(f, "SELL"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum OrderType {
    #[serde(rename = "GTC")]
    #[default]
    Gtc,
    #[serde(rename = "FOK")]
    Fok,
    #[serde(rename = "GTD")]
    Gtd,
    #[serde(rename = "FAK")]
    Fak,
}

impl fmt::Display for OrderType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gtc => write!(f, "GTC"),
            Self::Fok => write!(f, "FOK"),
            Self::Gtd => write!(f, "GTD"),
            Self::Fak => write!(f, "FAK"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderStatus {
    Pending,
    Open,
    Filled,
    PartiallyFilled,
    Cancelled,
    Expired,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderParams {
    pub token_id: String,
    pub side: OrderSide,
    pub price: Decimal,
    pub size: Decimal,
    #[serde(default)]
    pub order_type: OrderType,
    #[serde(default)]
    pub fee_rate_bps: u32,
    pub expiration: Option<u64>,
    pub nonce: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    pub success: bool,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
    #[serde(rename = "orderId")]
    pub order_id: Option<String>,
    #[serde(rename = "orderHashes")]
    pub order_hashes: Option<Vec<String>>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenOrder {
    pub order_id: String,
    pub user_id: String,
    pub market_id: String,
    pub token_id: String,
    pub side: OrderSide,
    #[serde(rename = "type")]
    pub order_type: String,
    pub status: String,
    pub price: String,
    pub size: String,
    pub filled_size: String,
    pub fees_paid: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookEntry {
    pub price: String,
    pub size: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    pub market: String,
    pub asset_id: String,
    pub bids: Vec<BookEntry>,
    pub asks: Vec<BookEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TradeStatus {
    Matched,
    Mined,
    Confirmed,
    Retrying,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    pub id: String,
    pub market: String,
    pub asset_id: String,
    pub side: OrderSide,
    pub price: String,
    pub size: String,
    pub timestamp: String,
    pub status: TradeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeEntry {
    pub trade_id: String,
    pub order_id: String,
    pub user_id: String,
    pub market_id: String,
    pub token_id: String,
    pub side: OrderSide,
    #[serde(rename = "type")]
    pub trade_type: String,
    pub price: String,
    pub size: String,
    pub fees_paid: String,
    pub timestamp: String,
    pub tx_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub market: String,
    pub asset_id: String,
    pub size: String,
    pub average_price: String,
    pub realized_pnl: String,
    pub unrealized_pnl: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Balance {
    pub asset: String,
    pub balance: String,
    pub symbol: String,
    pub decimals: u8,
}

#[derive(Debug, Clone)]
pub struct ApiKeyCreds {
    pub key: String,
    pub secret: String,
    pub passphrase: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyType {
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyStatus {
    Active,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    pub key_id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub key_type: ApiKeyType,
    pub status: ApiKeyStatus,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub is_cert_whitelisted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketsResponse {
    pub limit: u32,
    pub count: u32,
    pub next_cursor: String,
    pub data: Vec<Market>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimplifiedMarketsResponse {
    pub limit: u32,
    pub count: u32,
    pub next_cursor: String,
    pub data: Vec<SimplifiedMarket>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradesResponse {
    pub data: Vec<TradeEntry>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketFilters {
    pub category: Option<String>,
    pub active: Option<bool>,
    pub limit: Option<u32>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GetTradesParams {
    pub user_address: Option<String>,
    pub market_id: Option<String>,
    pub token_id: Option<String>,
    pub from_timestamp: Option<u64>,
    pub to_timestamp: Option<u64>,
    pub limit: Option<u32>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPrice {
    pub token_id: String,
    pub price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceHistoryEntry {
    pub timestamp: String,
    pub price: String,
    pub volume: Option<String>,
}
