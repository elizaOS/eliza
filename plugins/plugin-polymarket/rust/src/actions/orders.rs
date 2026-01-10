//! Order placement actions for Polymarket

use rust_decimal::Decimal;

use crate::client::ClobClient;
use crate::error::{PolymarketError, Result};
use crate::types::{OrderParams, OrderResponse, OrderSide, OrderType};

/// Validate order parameters
fn validate_order_params(params: &OrderParams) -> Result<()> {
    if params.token_id.is_empty() {
        return Err(PolymarketError::invalid_order("Token ID is required"));
    }

    if params.price <= Decimal::ZERO || params.price > Decimal::ONE {
        return Err(PolymarketError::invalid_order(
            "Price must be between 0 and 1",
        ));
    }

    if params.size <= Decimal::ZERO {
        return Err(PolymarketError::invalid_order("Size must be positive"));
    }

    Ok(())
}

/// Place an order on Polymarket
///
/// # Arguments
///
/// * `client` - The authenticated CLOB client
/// * `params` - Order parameters
///
/// # Errors
///
/// Returns an error if validation fails or order placement fails
pub async fn place_order(client: &ClobClient, params: OrderParams) -> Result<OrderResponse> {
    validate_order_params(&params)?;

    if !client.has_credentials() {
        return Err(PolymarketError::new(
            crate::error::PolymarketErrorCode::AuthError,
            "API credentials required for placing orders",
        ));
    }

    client.place_order(params).await
}

/// Create order parameters helper
///
/// # Arguments
///
/// * `token_id` - The token ID to trade
/// * `side` - Order side (BUY or SELL)
/// * `price` - Price per share (0-1.0)
/// * `size` - Order size
///
/// # Returns
///
/// Order parameters with default values
#[must_use]
pub fn create_order_params(
    token_id: impl Into<String>,
    side: OrderSide,
    price: Decimal,
    size: Decimal,
) -> OrderParams {
    OrderParams {
        token_id: token_id.into(),
        side,
        price,
        size,
        order_type: OrderType::default(),
        fee_rate_bps: 0,
        expiration: None,
        nonce: None,
    }
}

/// Create limit order parameters
///
/// # Arguments
///
/// * `token_id` - The token ID to trade
/// * `side` - Order side (BUY or SELL)
/// * `price` - Price per share (0-1.0)
/// * `size` - Order size
#[must_use]
pub fn create_limit_order(
    token_id: impl Into<String>,
    side: OrderSide,
    price: Decimal,
    size: Decimal,
) -> OrderParams {
    OrderParams {
        token_id: token_id.into(),
        side,
        price,
        size,
        order_type: OrderType::Gtc,
        fee_rate_bps: 0,
        expiration: None,
        nonce: None,
    }
}

/// Create market order parameters (FOK - Fill or Kill)
///
/// # Arguments
///
/// * `token_id` - The token ID to trade
/// * `side` - Order side (BUY or SELL)
/// * `price` - Maximum/minimum price
/// * `size` - Order size
#[must_use]
pub fn create_market_order(
    token_id: impl Into<String>,
    side: OrderSide,
    price: Decimal,
    size: Decimal,
) -> OrderParams {
    OrderParams {
        token_id: token_id.into(),
        side,
        price,
        size,
        order_type: OrderType::Fok,
        fee_rate_bps: 0,
        expiration: None,
        nonce: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_order_params_valid() {
        let params = OrderParams {
            token_id: "123456".to_string(),
            side: OrderSide::Buy,
            price: Decimal::new(50, 2), // 0.50
            size: Decimal::new(100, 0),
            order_type: OrderType::Gtc,
            fee_rate_bps: 0,
            expiration: None,
            nonce: None,
        };

        assert!(validate_order_params(&params).is_ok());
    }

    #[test]
    fn test_validate_order_params_empty_token() {
        let params = OrderParams {
            token_id: "".to_string(),
            side: OrderSide::Buy,
            price: Decimal::new(50, 2),
            size: Decimal::new(100, 0),
            order_type: OrderType::Gtc,
            fee_rate_bps: 0,
            expiration: None,
            nonce: None,
        };

        assert!(validate_order_params(&params).is_err());
    }

    #[test]
    fn test_validate_order_params_invalid_price() {
        let params = OrderParams {
            token_id: "123456".to_string(),
            side: OrderSide::Buy,
            price: Decimal::new(150, 2), // 1.50 - invalid
            size: Decimal::new(100, 0),
            order_type: OrderType::Gtc,
            fee_rate_bps: 0,
            expiration: None,
            nonce: None,
        };

        assert!(validate_order_params(&params).is_err());
    }

    #[test]
    fn test_validate_order_params_zero_size() {
        let params = OrderParams {
            token_id: "123456".to_string(),
            side: OrderSide::Buy,
            price: Decimal::new(50, 2),
            size: Decimal::ZERO,
            order_type: OrderType::Gtc,
            fee_rate_bps: 0,
            expiration: None,
            nonce: None,
        };

        assert!(validate_order_params(&params).is_err());
    }

    #[test]
    fn test_create_limit_order() {
        let params = create_limit_order(
            "123456",
            OrderSide::Buy,
            Decimal::new(50, 2),
            Decimal::new(100, 0),
        );

        assert_eq!(params.token_id, "123456");
        assert_eq!(params.side, OrderSide::Buy);
        assert_eq!(params.order_type, OrderType::Gtc);
    }

    #[test]
    fn test_create_market_order() {
        let params = create_market_order(
            "123456",
            OrderSide::Sell,
            Decimal::new(45, 2),
            Decimal::new(50, 0),
        );

        assert_eq!(params.token_id, "123456");
        assert_eq!(params.side, OrderSide::Sell);
        assert_eq!(params.order_type, OrderType::Fok);
    }
}

