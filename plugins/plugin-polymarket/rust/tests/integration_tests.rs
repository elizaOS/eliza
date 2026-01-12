//! Integration tests for polymarket plugin.

use elizaos_plugin_polymarket::types::{
    ApiKeyStatus, ApiKeyType, Balance, BookEntry, GetTradesParams, MarketFilters, OrderBook,
    OrderSide, OrderStatus, OrderType, Position, PriceHistoryEntry, Token, TokenPrice, TradeStatus,
};

#[test]
fn test_token_serialization() {
    let token = Token {
        token_id: "token-123".to_string(),
        outcome: "YES".to_string(),
    };

    let json = serde_json::to_string(&token).unwrap();
    assert!(json.contains("token-123"));
    assert!(json.contains("YES"));

    let parsed: Token = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.token_id, "token-123");
    assert_eq!(parsed.outcome, "YES");
}

#[test]
fn test_order_side_display() {
    assert_eq!(format!("{}", OrderSide::Buy), "BUY");
    assert_eq!(format!("{}", OrderSide::Sell), "SELL");
}

#[test]
fn test_order_side_serialization() {
    let side = OrderSide::Buy;
    let json = serde_json::to_string(&side).unwrap();
    assert_eq!(json, "\"BUY\"");
}

#[test]
fn test_order_type_default() {
    let order_type = OrderType::default();
    assert_eq!(order_type, OrderType::Gtc);
}

#[test]
fn test_order_type_display() {
    assert_eq!(format!("{}", OrderType::Gtc), "GTC");
    assert_eq!(format!("{}", OrderType::Fok), "FOK");
    assert_eq!(format!("{}", OrderType::Gtd), "GTD");
    assert_eq!(format!("{}", OrderType::Fak), "FAK");
}

#[test]
fn test_order_status_serialization() {
    let status = OrderStatus::Open;
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("OPEN"));

    let status = OrderStatus::Filled;
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("FILLED"));
}

#[test]
fn test_trade_status_serialization() {
    let status = TradeStatus::Matched;
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("MATCHED"));

    let status = TradeStatus::Confirmed;
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("CONFIRMED"));
}

#[test]
fn test_book_entry_serialization() {
    let entry = BookEntry {
        price: "0.65".to_string(),
        size: "100".to_string(),
    };

    let json = serde_json::to_string(&entry).unwrap();
    assert!(json.contains("0.65"));
    assert!(json.contains("100"));
}

#[test]
fn test_order_book_serialization() {
    let book = OrderBook {
        market: "market-1".to_string(),
        asset_id: "asset-1".to_string(),
        bids: vec![BookEntry {
            price: "0.60".to_string(),
            size: "50".to_string(),
        }],
        asks: vec![BookEntry {
            price: "0.65".to_string(),
            size: "75".to_string(),
        }],
    };

    let json = serde_json::to_string(&book).unwrap();
    assert!(json.contains("market-1"));
    assert!(json.contains("bids"));
    assert!(json.contains("asks"));
}

#[test]
fn test_position_serialization() {
    let position = Position {
        market: "market-1".to_string(),
        asset_id: "asset-1".to_string(),
        size: "100".to_string(),
        average_price: "0.55".to_string(),
        realized_pnl: "10".to_string(),
        unrealized_pnl: "5".to_string(),
    };

    let json = serde_json::to_string(&position).unwrap();
    assert!(json.contains("market-1"));
    assert!(json.contains("average_price"));
}

#[test]
fn test_balance_serialization() {
    let balance = Balance {
        asset: "0x123...".to_string(),
        balance: "1000".to_string(),
        symbol: "USDC".to_string(),
        decimals: 6,
    };

    let json = serde_json::to_string(&balance).unwrap();
    assert!(json.contains("USDC"));
    assert!(json.contains("1000"));
}

#[test]
fn test_api_key_type_serialization() {
    let key_type = ApiKeyType::ReadOnly;
    let json = serde_json::to_string(&key_type).unwrap();
    assert_eq!(json, "\"read_only\"");

    let key_type = ApiKeyType::ReadWrite;
    let json = serde_json::to_string(&key_type).unwrap();
    assert_eq!(json, "\"read_write\"");
}

#[test]
fn test_api_key_status_serialization() {
    let status = ApiKeyStatus::Active;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"active\"");

    let status = ApiKeyStatus::Revoked;
    let json = serde_json::to_string(&status).unwrap();
    assert_eq!(json, "\"revoked\"");
}

#[test]
fn test_market_filters_default() {
    let filters = MarketFilters::default();
    assert!(filters.category.is_none());
    assert!(filters.active.is_none());
    assert!(filters.limit.is_none());
}

#[test]
fn test_get_trades_params_default() {
    let params = GetTradesParams::default();
    assert!(params.user_address.is_none());
    assert!(params.market_id.is_none());
    assert!(params.limit.is_none());
}

#[test]
fn test_token_price_serialization() {
    let price = TokenPrice {
        token_id: "token-1".to_string(),
        price: "0.72".to_string(),
    };

    let json = serde_json::to_string(&price).unwrap();
    assert!(json.contains("token-1"));
    assert!(json.contains("0.72"));
}

#[test]
fn test_price_history_entry_serialization() {
    let entry = PriceHistoryEntry {
        timestamp: "2024-01-01T00:00:00Z".to_string(),
        price: "0.65".to_string(),
        volume: Some("1000".to_string()),
    };

    let json = serde_json::to_string(&entry).unwrap();
    assert!(json.contains("2024-01-01"));
    assert!(json.contains("0.65"));
}
