#![allow(missing_docs)]
//! Order book actions for Polymarket

use crate::client::ClobClient;
use crate::error::Result;
use crate::types::{OrderBook, OrderSide};

/// Get order book for a token
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_id` - The token ID
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_order_book(client: &ClobClient, token_id: &str) -> Result<OrderBook> {
    client.get_order_book(token_id).await
}

/// Get best price for a token on specified side
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_id` - The token ID
/// * `side` - BUY or SELL
///
/// # Returns
///
/// Tuple of (price, size) for best price, or (None, None) if no orders
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_best_price(
    client: &ClobClient,
    token_id: &str,
    side: OrderSide,
) -> Result<(Option<String>, Option<String>)> {
    let order_book = client.get_order_book(token_id).await?;

    let best = match side {
        OrderSide::Buy => order_book.asks.first(),
        OrderSide::Sell => order_book.bids.first(),
    };

    match best {
        Some(entry) => Ok((Some(entry.price.clone()), Some(entry.size.clone()))),
        None => Ok((None, None)),
    }
}

/// Get midpoint price for a token
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_id` - The token ID
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_midpoint_price(client: &ClobClient, token_id: &str) -> Result<String> {
    client.get_midpoint(token_id).await
}

/// Get bid-ask spread for a token
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_id` - The token ID
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_spread(client: &ClobClient, token_id: &str) -> Result<String> {
    client.get_spread(token_id).await
}

/// Calculate order book summary
///
/// # Arguments
///
/// * `order_book` - The order book data
///
/// # Returns
///
/// Tuple of (best_bid, best_ask, spread, bid_depth, ask_depth)
#[must_use]
pub fn calculate_order_book_summary(
    order_book: &OrderBook,
) -> (Option<&str>, Option<&str>, Option<f64>, usize, usize) {
    let best_bid = order_book.bids.first().map(|e| e.price.as_str());
    let best_ask = order_book.asks.first().map(|e| e.price.as_str());

    let spread = match (best_bid, best_ask) {
        (Some(bid), Some(ask)) => {
            let bid: &str = bid;
            let ask: &str = ask;
            let bid_f: f64 = bid.parse::<f64>().unwrap_or(0.0);
            let ask_f: f64 = ask.parse::<f64>().unwrap_or(0.0);
            Some(ask_f - bid_f)
        }
        _ => None,
    };

    let bid_depth = order_book.bids.len();
    let ask_depth = order_book.asks.len();

    (best_bid, best_ask, spread, bid_depth, ask_depth)
}

/// Get order book summary for a token
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_id` - The token ID
///
/// # Returns
///
/// Tuple of (best_bid, best_ask, spread, bid_depth, ask_depth)
///
/// # Errors
///
/// Returns an error if the API request fails
pub async fn get_order_book_summary(
    client: &ClobClient,
    token_id: &str,
) -> Result<(Option<String>, Option<String>, Option<f64>, usize, usize)> {
    let order_book = client.get_order_book(token_id).await?;
    let (best_bid, best_ask, spread, bid_depth, ask_depth) =
        calculate_order_book_summary(&order_book);

    Ok((
        best_bid.map(String::from),
        best_ask.map(String::from),
        spread,
        bid_depth,
        ask_depth,
    ))
}

/// Order book depth information
#[derive(Debug, Clone, serde::Serialize)]
pub struct OrderBookDepth {
    /// Number of bid levels
    pub bid_levels: usize,
    /// Number of ask levels
    pub ask_levels: usize,
    /// Total bid size
    pub total_bid_size: f64,
    /// Total ask size
    pub total_ask_size: f64,
}

/// Get order book depth for multiple tokens
///
/// # Arguments
///
/// * `client` - The CLOB client
/// * `token_ids` - List of token IDs to get depth for
///
/// # Returns
///
/// Map of token ID to depth information
///
/// # Errors
///
/// Returns an error if any API request fails
pub async fn get_order_book_depth(
    client: &ClobClient,
    token_ids: &[String],
) -> Result<std::collections::HashMap<String, OrderBookDepth>> {
    use std::collections::HashMap;

    let mut result = HashMap::new();

    for token_id in token_ids {
        match client.get_order_book(token_id).await {
            Ok(order_book) => {
                let total_bid_size: f64 = order_book
                    .bids
                    .iter()
                    .filter_map(|e| e.size.parse::<f64>().ok())
                    .sum();
                let total_ask_size: f64 = order_book
                    .asks
                    .iter()
                    .filter_map(|e| e.size.parse::<f64>().ok())
                    .sum();

                result.insert(
                    token_id.clone(),
                    OrderBookDepth {
                        bid_levels: order_book.bids.len(),
                        ask_levels: order_book.asks.len(),
                        total_bid_size,
                        total_ask_size,
                    },
                );
            }
            Err(e) => {
                // Log error but continue with other tokens
                eprintln!("Failed to get order book for {}: {}", token_id, e);
            }
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::BookEntry;

    #[test]
    fn test_calculate_order_book_summary() {
        let order_book = OrderBook {
            market: "test".to_string(),
            asset_id: "123".to_string(),
            bids: vec![
                BookEntry {
                    price: "0.45".to_string(),
                    size: "100".to_string(),
                },
                BookEntry {
                    price: "0.44".to_string(),
                    size: "50".to_string(),
                },
            ],
            asks: vec![
                BookEntry {
                    price: "0.55".to_string(),
                    size: "100".to_string(),
                },
                BookEntry {
                    price: "0.56".to_string(),
                    size: "50".to_string(),
                },
            ],
        };

        let (best_bid, best_ask, spread, bid_depth, ask_depth) =
            calculate_order_book_summary(&order_book);

        assert_eq!(best_bid, Some("0.45"));
        assert_eq!(best_ask, Some("0.55"));
        assert!((spread.unwrap() - 0.1).abs() < 0.001);
        assert_eq!(bid_depth, 2);
        assert_eq!(ask_depth, 2);
    }

    #[test]
    fn test_empty_order_book_summary() {
        let order_book = OrderBook {
            market: "test".to_string(),
            asset_id: "123".to_string(),
            bids: vec![],
            asks: vec![],
        };

        let (best_bid, best_ask, spread, bid_depth, ask_depth) =
            calculate_order_book_summary(&order_book);

        assert_eq!(best_bid, None);
        assert_eq!(best_ask, None);
        assert_eq!(spread, None);
        assert_eq!(bid_depth, 0);
        assert_eq!(ask_depth, 0);
    }
}
