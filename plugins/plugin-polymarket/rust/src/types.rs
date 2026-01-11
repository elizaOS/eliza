#![allow(missing_docs)]
//! Type definitions for the Polymarket plugin
//!
//! This module provides strongly typed definitions for all Polymarket operations.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::fmt;

// =============================================================================
// Token Types
// =============================================================================

/// Token representing a binary outcome in a prediction market
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    /// ERC1155 token ID
    pub token_id: String,
    /// Human readable outcome (e.g., "YES", "NO")
    pub outcome: String,
}

// =============================================================================
// Market Types
// =============================================================================

/// Rewards configuration for a market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rewards {
    /// Minimum size of an order to score rewards
    pub min_size: f64,
    /// Maximum spread from midpoint until order scores
    pub max_spread: f64,
    /// String date when event starts
    pub event_start_date: String,
    /// String date when event ends
    pub event_end_date: String,
    /// Reward multiplier while game started
    pub in_game_multiplier: f64,
    /// Current reward epoch
    pub reward_epoch: i64,
}

/// Market object representing a Polymarket prediction market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    /// CTF condition ID
    pub condition_id: String,
    /// CTF question ID
    pub question_id: String,
    /// Binary token pair for market
    pub tokens: (Token, Token),
    /// Rewards related data
    pub rewards: Rewards,
    /// Minimum limit order size
    pub minimum_order_size: String,
    /// Minimum tick size in implied probability
    pub minimum_tick_size: String,
    /// Market category
    pub category: String,
    /// ISO string of market end date
    pub end_date_iso: String,
    /// ISO string of game start time
    pub game_start_time: String,
    /// Market question
    pub question: String,
    /// Slug of market
    pub market_slug: String,
    /// Minimum resting order size for incentives
    pub min_incentive_size: String,
    /// Max spread for incentive qualification
    pub max_incentive_spread: String,
    /// Whether market is active/live
    pub active: bool,
    /// Whether market is closed
    pub closed: bool,
    /// Seconds of match delay for in-game trade
    pub seconds_delay: i64,
    /// Reference to market icon image
    pub icon: String,
    /// Address of associated FPMM on Polygon
    pub fpmm: String,
}

/// Simplified market with reduced fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimplifiedMarket {
    /// CTF condition ID
    pub condition_id: String,
    /// Binary token pair
    pub tokens: (Token, Token),
    /// Rewards data
    pub rewards: Rewards,
    /// Min incentive size
    pub min_incentive_size: String,
    /// Max incentive spread
    pub max_incentive_spread: String,
    /// Whether active
    pub active: bool,
    /// Whether closed
    pub closed: bool,
}

// =============================================================================
// Order Types
// =============================================================================

/// Order side enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderSide {
    /// Buy order
    Buy,
    /// Sell order
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

/// Order type enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    /// Good Till Cancelled
    #[serde(rename = "GTC")]
    Gtc,
    /// Fill Or Kill
    #[serde(rename = "FOK")]
    Fok,
    /// Good Till Date
    #[serde(rename = "GTD")]
    Gtd,
    /// Fill And Kill
    #[serde(rename = "FAK")]
    Fak,
}


impl Default for OrderType {
    fn default() -> Self {
        Self::Gtc
    }
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

/// Order status enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OrderStatus {
    /// Pending
    Pending,
    /// Open
    Open,
    /// Filled
    Filled,
    /// Partially filled
    PartiallyFilled,
    /// Cancelled
    Cancelled,
    /// Expired
    Expired,
    /// Rejected
    Rejected,
}

/// Parameters for creating orders
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderParams {
    /// Token ID to trade
    pub token_id: String,
    /// Order side
    pub side: OrderSide,
    /// Price per share (0-1.0)
    pub price: Decimal,
    /// Order size
    pub size: Decimal,
    /// Order type
    #[serde(default)]
    pub order_type: OrderType,
    /// Fee rate in basis points
    #[serde(default)]
    pub fee_rate_bps: u32,
    /// Expiration timestamp
    pub expiration: Option<u64>,
    /// Nonce
    pub nonce: Option<u64>,
}

/// Order response from CLOB API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    /// Success flag
    pub success: bool,
    /// Error message if unsuccessful
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
    /// Order ID
    #[serde(rename = "orderId")]
    pub order_id: Option<String>,
    /// Order hashes if matched
    #[serde(rename = "orderHashes")]
    pub order_hashes: Option<Vec<String>>,
    /// Order status
    pub status: Option<String>,
}

/// Open order details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenOrder {
    /// Order ID
    pub order_id: String,
    /// User ID
    pub user_id: String,
    /// Market ID
    pub market_id: String,
    /// Token ID
    pub token_id: String,
    /// Side
    pub side: OrderSide,
    /// Type
    #[serde(rename = "type")]
    pub order_type: String,
    /// Status
    pub status: String,
    /// Price
    pub price: String,
    /// Size
    pub size: String,
    /// Filled size
    pub filled_size: String,
    /// Fees paid
    pub fees_paid: String,
    /// Created at
    pub created_at: String,
    /// Updated at
    pub updated_at: String,
}

// =============================================================================
// Order Book Types
// =============================================================================

/// Order book entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookEntry {
    /// Price level
    pub price: String,
    /// Size at this level
    pub size: String,
}

/// Order book data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBook {
    /// Market ID
    pub market: String,
    /// Asset ID
    pub asset_id: String,
    /// Bid orders
    pub bids: Vec<BookEntry>,
    /// Ask orders
    pub asks: Vec<BookEntry>,
}

// =============================================================================
// Trade Types
// =============================================================================

/// Trade status enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TradeStatus {
    /// Matched
    Matched,
    /// Mined
    Mined,
    /// Confirmed
    Confirmed,
    /// Retrying
    Retrying,
    /// Failed
    Failed,
}

/// Trade data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trade {
    /// Trade ID
    pub id: String,
    /// Market ID
    pub market: String,
    /// Asset ID
    pub asset_id: String,
    /// Side
    pub side: OrderSide,
    /// Price
    pub price: String,
    /// Size
    pub size: String,
    /// Timestamp
    pub timestamp: String,
    /// Status
    pub status: TradeStatus,
}

/// Trade entry from history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeEntry {
    /// Trade ID
    pub trade_id: String,
    /// Order ID
    pub order_id: String,
    /// User ID
    pub user_id: String,
    /// Market ID
    pub market_id: String,
    /// Token ID
    pub token_id: String,
    /// Side
    pub side: OrderSide,
    /// Type
    #[serde(rename = "type")]
    pub trade_type: String,
    /// Price
    pub price: String,
    /// Size
    pub size: String,
    /// Fees paid
    pub fees_paid: String,
    /// Timestamp
    pub timestamp: String,
    /// Transaction hash
    pub tx_hash: String,
}

// =============================================================================
// Position Types
// =============================================================================

/// User position in a market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    /// Market ID
    pub market: String,
    /// Asset ID
    pub asset_id: String,
    /// Size
    pub size: String,
    /// Average price
    pub average_price: String,
    /// Realized PnL
    pub realized_pnl: String,
    /// Unrealized PnL
    pub unrealized_pnl: String,
}

/// Balance data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Balance {
    /// Asset address
    pub asset: String,
    /// Balance amount
    pub balance: String,
    /// Symbol
    pub symbol: String,
    /// Decimals
    pub decimals: u8,
}

// =============================================================================
// API Key Types
// =============================================================================

/// API key credentials
#[derive(Debug, Clone)]
pub struct ApiKeyCreds {
    /// API key
    pub key: String,
    /// API secret
    pub secret: String,
    /// Passphrase
    pub passphrase: String,
}

/// API key type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyType {
    /// Read only
    ReadOnly,
    /// Read write
    ReadWrite,
}

/// API key status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyStatus {
    /// Active
    Active,
    /// Revoked
    Revoked,
}

/// API key details
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKey {
    /// Key ID
    pub key_id: String,
    /// Label
    pub label: String,
    /// Type
    #[serde(rename = "type")]
    pub key_type: ApiKeyType,
    /// Status
    pub status: ApiKeyStatus,
    /// Created at
    pub created_at: String,
    /// Last used at
    pub last_used_at: Option<String>,
    /// Is cert whitelisted
    pub is_cert_whitelisted: bool,
}

// =============================================================================
// Response Types
// =============================================================================

/// Paginated markets response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketsResponse {
    /// Limit
    pub limit: u32,
    /// Count
    pub count: u32,
    /// Next cursor
    pub next_cursor: String,
    /// Data
    pub data: Vec<Market>,
}

/// Paginated simplified markets response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimplifiedMarketsResponse {
    /// Limit
    pub limit: u32,
    /// Count
    pub count: u32,
    /// Next cursor
    pub next_cursor: String,
    /// Data
    pub data: Vec<SimplifiedMarket>,
}

/// Paginated trades response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradesResponse {
    /// Data
    pub data: Vec<TradeEntry>,
    /// Next cursor
    pub next_cursor: String,
}

// =============================================================================
// Filter Types
// =============================================================================

/// Market filters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketFilters {
    /// Category filter
    pub category: Option<String>,
    /// Active filter
    pub active: Option<bool>,
    /// Limit
    pub limit: Option<u32>,
    /// Next cursor
    pub next_cursor: Option<String>,
}

/// Get trades parameters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GetTradesParams {
    /// User address
    pub user_address: Option<String>,
    /// Market ID
    pub market_id: Option<String>,
    /// Token ID
    pub token_id: Option<String>,
    /// From timestamp
    pub from_timestamp: Option<u64>,
    /// To timestamp
    pub to_timestamp: Option<u64>,
    /// Limit
    pub limit: Option<u32>,
    /// Next cursor
    pub next_cursor: Option<String>,
}

// =============================================================================
// Price Types
// =============================================================================

/// Token price
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPrice {
    /// Token ID
    pub token_id: String,
    /// Price
    pub price: String,
}

/// Price history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceHistoryEntry {
    /// Timestamp
    pub timestamp: String,
    /// Price
    pub price: String,
    /// Volume
    pub volume: Option<String>,
}




