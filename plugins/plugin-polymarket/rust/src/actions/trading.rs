//! Trading-related actions for Polymarket.
//!
//! This module provides functions for:
//! - Getting balances (collateral and conditional tokens)
//! - Getting positions
//! - Getting trade history
//! - Getting price history
//! - Checking order scoring

use crate::client::ClobClient;
use crate::error::{PolymarketError, Result};
use crate::types::{BalanceAllowance, OrderSide, PriceHistoryEntry, TradesResponse};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// =============================================================================
// Balances
// =============================================================================

/// Response from balance endpoints
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceResponse {
    /// Collateral (USDC) balance
    pub collateral: Option<BalanceAllowance>,
    /// Conditional token balances by token ID
    pub conditional: HashMap<String, BalanceAllowance>,
}

/// Get account balances.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `token_ids` - Optional list of token IDs to get conditional balances for
/// * `include_collateral` - Whether to include USDC collateral balance
/// * `include_conditional` - Whether to include conditional token balances
///
/// # Returns
///
/// Balance information including collateral and conditional tokens.
pub async fn get_balances(
    client: &ClobClient,
    token_ids: Option<&[String]>,
    include_collateral: bool,
    include_conditional: bool,
) -> Result<BalanceResponse> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for balance queries",
        ));
    }

    let mut response = BalanceResponse {
        collateral: None,
        conditional: HashMap::new(),
    };

    // Get collateral balance if requested
    if include_collateral {
        let balance = client.get_collateral_balance().await?;
        response.collateral = Some(balance);
    }

    // Get conditional balances if requested
    if include_conditional {
        if let Some(tokens) = token_ids {
            for token_id in tokens {
                match client.get_conditional_balance(token_id).await {
                    Ok(balance) => {
                        response.conditional.insert(token_id.clone(), balance);
                    }
                    Err(e) => {
                        // Log error but continue with other tokens
                        eprintln!("Failed to get balance for token {}: {}", token_id, e);
                    }
                }
            }
        }
    }

    Ok(response)
}

// =============================================================================
// Positions
// =============================================================================

/// Position information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    /// Market condition ID
    pub market: String,
    /// Token ID
    pub asset_id: String,
    /// Position size
    pub size: String,
    /// Average entry price
    pub average_price: String,
    /// Realized profit/loss
    pub realized_pnl: String,
    /// Unrealized profit/loss
    pub unrealized_pnl: String,
}

/// Get user positions.
///
/// Builds positions from trade history, calculating realized and unrealized PnL.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `limit` - Maximum number of trades to fetch per page
/// * `max_pages` - Maximum pages to fetch
/// * `asset_ids` - Optional filter by asset IDs
/// * `include_prices` - Whether to include current prices for unrealized PnL
///
/// # Returns
///
/// List of positions with PnL calculations.
pub async fn get_positions(
    client: &ClobClient,
    limit: Option<u32>,
    max_pages: Option<u32>,
    asset_ids: Option<&[String]>,
    include_prices: bool,
) -> Result<Vec<Position>> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for position queries",
        ));
    }

    let trades = client
        .get_trades(None, asset_ids, limit, max_pages)
        .await?;

    // Build positions from trades
    let mut position_map: HashMap<String, PositionAccumulator> = HashMap::new();

    for trade in &trades.data {
        let entry = position_map
            .entry(trade.token_id.clone())
            .or_insert_with(|| PositionAccumulator {
                market: trade.market_id.clone(),
                asset_id: trade.token_id.clone(),
                total_bought: 0.0,
                total_sold: 0.0,
                total_cost: 0.0,
                total_proceeds: 0.0,
            });

        let price = trade.price.parse::<f64>().unwrap_or(0.0);
        let size = trade.size.parse::<f64>().unwrap_or(0.0);

        match trade.side {
            OrderSide::Buy => {
                entry.total_bought += size;
                entry.total_cost += price * size;
            }
            OrderSide::Sell => {
                entry.total_sold += size;
                entry.total_proceeds += price * size;
            }
        }
    }

    // Convert accumulators to positions
    let mut positions = Vec::new();

    for (asset_id, acc) in position_map {
        let net_size = acc.total_bought - acc.total_sold;
        if net_size.abs() < 0.0001 {
            continue; // Skip zero positions
        }

        let avg_price = if acc.total_bought > 0.0 {
            acc.total_cost / acc.total_bought
        } else {
            0.0
        };

        let realized_pnl = acc.total_proceeds - (acc.total_sold * avg_price);

        // Get current price for unrealized PnL if requested
        let unrealized_pnl = if include_prices && net_size > 0.0 {
            match client.get_midpoint(&asset_id).await {
                Ok(mid) => {
                    let current_price = mid.parse::<f64>().unwrap_or(0.0);
                    (current_price - avg_price) * net_size
                }
                Err(_) => 0.0,
            }
        } else {
            0.0
        };

        positions.push(Position {
            market: acc.market,
            asset_id,
            size: format!("{:.6}", net_size),
            average_price: format!("{:.4}", avg_price),
            realized_pnl: format!("{:.4}", realized_pnl),
            unrealized_pnl: format!("{:.4}", unrealized_pnl),
        });
    }

    Ok(positions)
}

/// Internal accumulator for position calculations
struct PositionAccumulator {
    market: String,
    #[allow(dead_code)]
    asset_id: String,
    total_bought: f64,
    total_sold: f64,
    total_cost: f64,
    total_proceeds: f64,
}

// =============================================================================
// Trade History
// =============================================================================

/// Get trade history.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `market_id` - Optional market filter
/// * `asset_ids` - Optional asset filter
/// * `limit` - Maximum trades per page
/// * `max_pages` - Maximum pages to fetch
///
/// # Returns
///
/// Trade history with pagination info.
pub async fn get_trade_history(
    client: &ClobClient,
    market_id: Option<&str>,
    asset_ids: Option<&[String]>,
    limit: Option<u32>,
    max_pages: Option<u32>,
) -> Result<TradesResponse> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for trade history",
        ));
    }

    client.get_trades(market_id, asset_ids, limit, max_pages).await
}

// =============================================================================
// Price History
// =============================================================================

/// Get price history for a token.
///
/// # Arguments
///
/// * `client` - CLOB client (no auth required)
/// * `token_id` - The token ID
/// * `start_ts` - Start timestamp (Unix seconds)
/// * `end_ts` - End timestamp (Unix seconds)
/// * `fidelity` - Time interval fidelity in minutes (1, 5, 15, 60, etc.)
///
/// # Returns
///
/// List of price history entries.
pub async fn get_price_history(
    client: &ClobClient,
    token_id: &str,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
    fidelity: Option<u32>,
) -> Result<Vec<PriceHistoryEntry>> {
    client
        .get_price_history(token_id, start_ts, end_ts, fidelity)
        .await
}

// =============================================================================
// Order Scoring
// =============================================================================

/// Check if orders are scoring (eligible for rewards).
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `order_ids` - List of order IDs to check
///
/// # Returns
///
/// Map of order ID to scoring status.
pub async fn check_order_scoring(
    client: &ClobClient,
    order_ids: &[String],
) -> Result<HashMap<String, bool>> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for order scoring check",
        ));
    }

    client.check_order_scoring(order_ids).await
}

// =============================================================================
// Order Details
// =============================================================================

/// Get details for a specific order.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `order_id` - The order ID
///
/// # Returns
///
/// Detailed order information.
pub async fn get_order_details(
    client: &ClobClient,
    order_id: &str,
) -> Result<crate::types::OpenOrder> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for order details",
        ));
    }

    client.get_order(order_id).await
}

/// Get active orders for the authenticated user.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `market_id` - Optional market filter
/// * `asset_id` - Optional asset filter
///
/// # Returns
///
/// List of active orders.
pub async fn get_active_orders(
    client: &ClobClient,
    market_id: Option<&str>,
    asset_id: Option<&str>,
) -> Result<Vec<crate::types::OpenOrder>> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required for active orders",
        ));
    }

    client.get_orders(market_id, asset_id).await
}
