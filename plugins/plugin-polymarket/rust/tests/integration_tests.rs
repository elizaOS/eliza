//! Integration tests for polymarket plugin.
//!
//! Includes type serialization, action metadata, action validation logic,
//! provider metadata, service configuration, and error handling tests.

use elizaos_plugin_polymarket::types::{
    ApiKeyStatus, ApiKeyType, Balance, BookEntry, GetTradesParams, MarketFilters, OrderBook,
    OrderSide, OrderStatus, OrderType, Position, PriceHistoryEntry, Token, TokenPrice, TradeStatus,
};
use elizaos_plugin_polymarket::actions::{
    // elizaos action name constants
    POLYMARKET_GET_MARKETS, POLYMARKET_GET_MARKET_DETAILS, POLYMARKET_RETRIEVE_ALL_MARKETS,
    POLYMARKET_GET_ORDER_BOOK, POLYMARKET_GET_ORDER_BOOK_DEPTH, POLYMARKET_GET_ORDER_BOOK_SUMMARY,
    POLYMARKET_GET_BEST_PRICE, POLYMARKET_GET_MIDPOINT_PRICE, POLYMARKET_GET_SPREAD,
    POLYMARKET_GET_BALANCES, POLYMARKET_GET_POSITIONS, POLYMARKET_PLACE_ORDER,
    POLYMARKET_GET_ORDER_DETAILS, POLYMARKET_GET_ACTIVE_ORDERS,
    POLYMARKET_GET_TRADE_HISTORY, POLYMARKET_GET_PRICE_HISTORY, POLYMARKET_CHECK_ORDER_SCORING,
    POLYMARKET_CREATE_API_KEY, POLYMARKET_GET_ALL_API_KEYS, POLYMARKET_REVOKE_API_KEY,
    POLYMARKET_GET_ACCOUNT_ACCESS_STATUS,
    POLYMARKET_HANDLE_AUTHENTICATION,
    POLYMARKET_SETUP_WEBSOCKET, POLYMARKET_HANDLE_REALTIME_UPDATES,
    POLYMARKET_SEARCH_MARKETS, POLYMARKET_RESEARCH_MARKET,
    ALL_ACTION_NAMES,
    // orderbook logic
    calculate_order_book_summary,
    // search helpers
    format_price, format_volume, parse_outcome_prices, parse_outcomes,
    // realtime helpers
    setup_websocket, handle_realtime_updates, SubscriptionStatus,
};
use elizaos_plugin_polymarket::constants::{
    DEFAULT_CLOB_API_URL, POLYGON_CHAIN_ID, POLYMARKET_SERVICE_NAME,
    END_CURSOR, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT,
};
use elizaos_plugin_polymarket::error::{PolymarketError, PolymarketErrorCode};
use elizaos_plugin_polymarket::providers::{
    get_providers, ProviderContext, ProviderResult,
};
use elizaos_plugin_polymarket::service::PolymarketService;

// ===========================================================================
// Original type serialization tests
// ===========================================================================

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

// ===========================================================================
// Action metadata tests (elizaOS action constants)
// ===========================================================================

#[test]
fn test_action_name_get_markets() {
    assert_eq!(POLYMARKET_GET_MARKETS, "POLYMARKET_GET_MARKETS");
}

#[test]
fn test_action_name_get_market_details() {
    assert_eq!(POLYMARKET_GET_MARKET_DETAILS, "POLYMARKET_GET_MARKET_DETAILS");
}

#[test]
fn test_action_name_retrieve_all_markets() {
    assert_eq!(POLYMARKET_RETRIEVE_ALL_MARKETS, "POLYMARKET_RETRIEVE_ALL_MARKETS");
}

#[test]
fn test_action_name_order_book() {
    assert_eq!(POLYMARKET_GET_ORDER_BOOK, "POLYMARKET_GET_ORDER_BOOK");
}

#[test]
fn test_action_name_place_order() {
    assert_eq!(POLYMARKET_PLACE_ORDER, "POLYMARKET_PLACE_ORDER");
}

#[test]
fn test_action_name_search_markets() {
    assert_eq!(POLYMARKET_SEARCH_MARKETS, "POLYMARKET_SEARCH_MARKETS");
}

#[test]
fn test_action_name_research_market() {
    assert_eq!(POLYMARKET_RESEARCH_MARKET, "POLYMARKET_RESEARCH_MARKET");
}

#[test]
fn test_all_action_names_contains_all_known_actions() {
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_MARKETS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_MARKET_DETAILS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_RETRIEVE_ALL_MARKETS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ORDER_BOOK));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ORDER_BOOK_DEPTH));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ORDER_BOOK_SUMMARY));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_BEST_PRICE));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_MIDPOINT_PRICE));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_SPREAD));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_BALANCES));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_POSITIONS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_PLACE_ORDER));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ORDER_DETAILS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ACTIVE_ORDERS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_TRADE_HISTORY));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_PRICE_HISTORY));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_CHECK_ORDER_SCORING));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_CREATE_API_KEY));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_GET_ALL_API_KEYS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_REVOKE_API_KEY));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_SEARCH_MARKETS));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_RESEARCH_MARKET));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_SETUP_WEBSOCKET));
    assert!(ALL_ACTION_NAMES.contains(&POLYMARKET_HANDLE_REALTIME_UPDATES));
}

#[test]
fn test_all_action_names_are_prefixed_with_polymarket() {
    for name in ALL_ACTION_NAMES {
        assert!(
            (*name).starts_with("POLYMARKET_"),
            "Action name '{}' should start with 'POLYMARKET_'",
            name
        );
    }
}

#[test]
fn test_all_action_names_count() {
    // There should be at least 20 actions registered
    assert!(
        ALL_ACTION_NAMES.len() >= 20,
        "Expected at least 20 actions, got {}",
        ALL_ACTION_NAMES.len()
    );
}

// ===========================================================================
// Order book summary logic tests
// ===========================================================================

#[test]
fn test_order_book_summary_with_data() {
    let book = OrderBook {
        market: "test".to_string(),
        asset_id: "123".to_string(),
        bids: vec![
            BookEntry { price: "0.50".to_string(), size: "200".to_string() },
            BookEntry { price: "0.48".to_string(), size: "100".to_string() },
        ],
        asks: vec![
            BookEntry { price: "0.55".to_string(), size: "150".to_string() },
            BookEntry { price: "0.57".to_string(), size: "75".to_string() },
        ],
    };

    let (best_bid, best_ask, spread, bid_depth, ask_depth) = calculate_order_book_summary(&book);

    assert_eq!(best_bid, Some("0.50"));
    assert_eq!(best_ask, Some("0.55"));
    let spread_val: f64 = spread.unwrap();
    assert!((spread_val - 0.05).abs() < 0.001);
    assert_eq!(bid_depth, 2);
    assert_eq!(ask_depth, 2);
}

#[test]
fn test_order_book_summary_empty() {
    let book = OrderBook {
        market: "test".to_string(),
        asset_id: "123".to_string(),
        bids: vec![],
        asks: vec![],
    };

    let (best_bid, best_ask, spread, bid_depth, ask_depth) = calculate_order_book_summary(&book);

    assert_eq!(best_bid, None);
    assert_eq!(best_ask, None);
    let spread_opt: Option<f64> = spread;
    assert!(spread_opt.is_none());
    assert_eq!(bid_depth, 0);
    assert_eq!(ask_depth, 0);
}

#[test]
fn test_order_book_summary_bids_only() {
    let book = OrderBook {
        market: "m".to_string(),
        asset_id: "a".to_string(),
        bids: vec![BookEntry { price: "0.40".to_string(), size: "50".to_string() }],
        asks: vec![],
    };

    let (best_bid, best_ask, spread, bid_depth, ask_depth) = calculate_order_book_summary(&book);

    assert_eq!(best_bid, Some("0.40"));
    assert_eq!(best_ask, None);
    let spread_opt: Option<f64> = spread;
    assert!(spread_opt.is_none());
    assert_eq!(bid_depth, 1);
    assert_eq!(ask_depth, 0);
}

#[test]
fn test_order_book_summary_asks_only() {
    let book = OrderBook {
        market: "m".to_string(),
        asset_id: "a".to_string(),
        bids: vec![],
        asks: vec![BookEntry { price: "0.60".to_string(), size: "30".to_string() }],
    };

    let (best_bid, best_ask, spread, _, _) = calculate_order_book_summary(&book);

    assert_eq!(best_bid, None);
    assert_eq!(best_ask, Some("0.60"));
    let spread_opt: Option<f64> = spread;
    assert!(spread_opt.is_none());
}

// ===========================================================================
// Search helper function tests
// ===========================================================================

#[test]
fn test_parse_outcomes_valid_json() {
    let outcomes = parse_outcomes(r#"["Yes", "No"]"#);
    assert_eq!(outcomes, vec!["Yes", "No"]);
}

#[test]
fn test_parse_outcomes_invalid_json() {
    let outcomes = parse_outcomes("not json");
    assert!(outcomes.is_empty());
}

#[test]
fn test_parse_outcomes_empty_array() {
    let outcomes = parse_outcomes("[]");
    assert!(outcomes.is_empty());
}

#[test]
fn test_parse_outcome_prices_valid() {
    let prices = parse_outcome_prices(r#"["0.65", "0.35"]"#);
    assert_eq!(prices.len(), 2);
    assert!((prices[0] - 0.65).abs() < 0.001);
    assert!((prices[1] - 0.35).abs() < 0.001);
}

#[test]
fn test_parse_outcome_prices_invalid() {
    let prices = parse_outcome_prices("not valid");
    assert!(prices.is_empty());
}

#[test]
fn test_format_price() {
    assert_eq!(format_price(0.65), "65.0%");
    assert_eq!(format_price(0.0), "0.0%");
    assert_eq!(format_price(1.0), "100.0%");
}

#[test]
fn test_format_volume_millions() {
    assert_eq!(format_volume(1_500_000.0), "$1.50M");
}

#[test]
fn test_format_volume_thousands() {
    assert_eq!(format_volume(25_000.0), "$25.0K");
}

#[test]
fn test_format_volume_small() {
    assert_eq!(format_volume(500.0), "$500");
}

// ===========================================================================
// WebSocket / Realtime action validation tests
// ===========================================================================

#[test]
fn test_setup_websocket_rejects_empty_url() {
    let client = make_test_client();
    let result = setup_websocket(&client, "", &[], &[], false);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("WebSocket URL is required"));
}

#[test]
fn test_setup_websocket_rejects_empty_channels() {
    let client = make_test_client();
    let result = setup_websocket(&client, "wss://ws.example.com", &[], &[], false);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("channel"));
}

#[test]
fn test_setup_websocket_rejects_invalid_channel() {
    let client = make_test_client();
    let channels = vec!["invalid_channel".to_string()];
    let result = setup_websocket(&client, "wss://ws.example.com", &channels, &[], false);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Invalid channel"));
}

#[test]
fn test_setup_websocket_success() {
    let client = make_test_client();
    let channels = vec!["book".to_string(), "price".to_string()];
    let assets = vec!["token-1".to_string()];
    let config = setup_websocket(&client, "wss://ws.example.com", &channels, &assets, false).unwrap();

    assert_eq!(config.url, "wss://ws.example.com");
    assert_eq!(config.channels.len(), 2);
    assert_eq!(config.asset_ids.len(), 1);
    assert!(!config.authenticated);
    assert_eq!(config.status, SubscriptionStatus::Disconnected);
}

#[test]
fn test_handle_realtime_subscribe_requires_channel() {
    let client = make_test_client();
    let result = handle_realtime_updates(&client, "subscribe", None, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Channel is required"));
}

#[test]
fn test_handle_realtime_subscribe_requires_assets() {
    let client = make_test_client();
    let result = handle_realtime_updates(&client, "subscribe", Some("book"), None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Asset IDs are required"));
}

#[test]
fn test_handle_realtime_subscribe_requires_nonempty_assets() {
    let client = make_test_client();
    let empty: Vec<String> = vec![];
    let result = handle_realtime_updates(&client, "subscribe", Some("book"), Some(&empty));
    assert!(result.is_err());
}

#[test]
fn test_handle_realtime_subscribe_success() {
    let client = make_test_client();
    let assets = vec!["token-1".to_string()];
    let result = handle_realtime_updates(&client, "subscribe", Some("price"), Some(&assets));
    assert!(result.is_ok());
    assert!(result.unwrap().contains("Subscribed"));
}

#[test]
fn test_handle_realtime_unsubscribe() {
    let client = make_test_client();
    let result = handle_realtime_updates(&client, "unsubscribe", Some("trade"), None);
    assert!(result.is_ok());
    assert!(result.unwrap().contains("Unsubscribed"));
}

#[test]
fn test_handle_realtime_status() {
    let client = make_test_client();
    let result = handle_realtime_updates(&client, "status", None, None);
    assert!(result.is_ok());
}

#[test]
fn test_handle_realtime_invalid_action() {
    let client = make_test_client();
    let result = handle_realtime_updates(&client, "restart", None, None);
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("Invalid action"));
}

// ===========================================================================
// Provider metadata and output tests
// ===========================================================================

#[test]
fn test_get_providers_returns_one_provider() {
    let providers = get_providers();
    assert_eq!(providers.len(), 1);
}

#[test]
fn test_polymarket_provider_name() {
    let providers = get_providers();
    assert_eq!(providers[0].name(), "POLYMARKET_PROVIDER");
}

#[test]
fn test_polymarket_provider_description() {
    let providers = get_providers();
    let desc = providers[0].description();
    assert!(desc.contains("Polymarket"));
    assert!(desc.contains("market"));
}

#[tokio::test]
async fn test_polymarket_provider_default_context() {
    let providers = get_providers();
    let context = ProviderContext::default();
    let result = providers[0].get(&context).await;

    assert!(result.text.contains("Polymarket CLOB"));
    assert!(result.text.contains(DEFAULT_CLOB_API_URL));
    assert!(result.text.contains("market_data"));
    // Without private key, wallet_operations should not be listed
    assert!(!result.text.contains("wallet_operations"));
    // Without API creds, authenticated_requests should not be listed
    assert!(!result.text.contains("authenticated_requests"));
}

#[tokio::test]
async fn test_polymarket_provider_with_private_key() {
    let providers = get_providers();
    let context = ProviderContext {
        clob_api_url: None,
        has_private_key: true,
        has_api_creds: false,
    };
    let result = providers[0].get(&context).await;

    assert!(result.text.contains("wallet_operations"));
    assert!(!result.text.contains("authenticated_requests"));
}

#[tokio::test]
async fn test_polymarket_provider_with_full_auth() {
    let providers = get_providers();
    let context = ProviderContext {
        clob_api_url: Some("https://custom-api.polymarket.com".to_string()),
        has_private_key: true,
        has_api_creds: true,
    };
    let result = providers[0].get(&context).await;

    assert!(result.text.contains("wallet_operations"));
    assert!(result.text.contains("authenticated_requests"));
    assert!(result.text.contains("custom-api.polymarket.com"));
}

#[tokio::test]
async fn test_polymarket_provider_values_structure() {
    let providers = get_providers();
    let context = ProviderContext::default();
    let result = providers[0].get(&context).await;

    // Values should contain expected keys
    assert!(result.values.is_object());
    let values = result.values.as_object().unwrap();
    assert!(values.contains_key("clobApiUrl"));
    assert!(values.contains_key("chainId"));
    assert!(values.contains_key("serviceStatus"));
    assert!(values.contains_key("hasPrivateKey"));
    assert!(values.contains_key("hasApiCreds"));
    assert!(values.contains_key("featuresAvailable"));
}

#[tokio::test]
async fn test_polymarket_provider_data_structure() {
    let providers = get_providers();
    let context = ProviderContext::default();
    let result = providers[0].get(&context).await;

    assert!(result.data.is_object());
    let data = result.data.as_object().unwrap();
    assert!(data.contains_key("timestamp"));
    assert!(data.contains_key("service"));
    assert_eq!(data["service"], "polymarket");
}

// ===========================================================================
// Service configuration tests
// ===========================================================================

#[test]
fn test_service_type_name() {
    assert_eq!(PolymarketService::SERVICE_TYPE, POLYMARKET_SERVICE_NAME);
    assert_eq!(PolymarketService::SERVICE_TYPE, "polymarket");
}

// ===========================================================================
// Constants tests
// ===========================================================================

#[test]
fn test_polygon_chain_id() {
    assert_eq!(POLYGON_CHAIN_ID, 137);
}

#[test]
fn test_default_clob_api_url() {
    assert_eq!(DEFAULT_CLOB_API_URL, "https://clob.polymarket.com");
}

#[test]
fn test_end_cursor() {
    assert_eq!(END_CURSOR, "LTE=");
}

#[test]
fn test_page_limits() {
    assert_eq!(DEFAULT_PAGE_LIMIT, 100);
    assert_eq!(MAX_PAGE_LIMIT, 500);
    assert!(DEFAULT_PAGE_LIMIT <= MAX_PAGE_LIMIT);
}

// ===========================================================================
// Error handling tests
// ===========================================================================

#[test]
fn test_error_display_includes_code_and_message() {
    let err = PolymarketError::new(PolymarketErrorCode::InvalidMarket, "Market not found");
    let display = format!("{}", err);
    assert!(display.contains("INVALID_MARKET"));
    assert!(display.contains("Market not found"));
}

#[test]
fn test_error_invalid_market_constructor() {
    let err = PolymarketError::invalid_market("bad market id");
    assert_eq!(err.code, PolymarketErrorCode::InvalidMarket);
    assert_eq!(err.message, "bad market id");
}

#[test]
fn test_error_invalid_token_constructor() {
    let err = PolymarketError::invalid_token("bad token");
    assert_eq!(err.code, PolymarketErrorCode::InvalidToken);
}

#[test]
fn test_error_invalid_order_constructor() {
    let err = PolymarketError::invalid_order("size too small");
    assert_eq!(err.code, PolymarketErrorCode::InvalidOrder);
}

#[test]
fn test_error_api_error_constructor() {
    let err = PolymarketError::api_error("server error");
    assert_eq!(err.code, PolymarketErrorCode::ApiError);
}

#[test]
fn test_error_config_error_constructor() {
    let err = PolymarketError::config_error("missing key");
    assert_eq!(err.code, PolymarketErrorCode::ConfigError);
}

#[test]
fn test_error_network_error_constructor() {
    let err = PolymarketError::network_error("timeout");
    assert_eq!(err.code, PolymarketErrorCode::NetworkError);
}

#[test]
fn test_error_auth_error_constructor() {
    let err = PolymarketError::auth_error("not authenticated");
    assert_eq!(err.code, PolymarketErrorCode::AuthError);
    assert_eq!(err.message, "not authenticated");
}

#[test]
fn test_error_with_cause() {
    let inner = std::io::Error::new(std::io::ErrorKind::TimedOut, "socket timeout");
    let err = PolymarketError::with_cause(
        PolymarketErrorCode::NetworkError,
        "connection failed",
        inner,
    );
    assert_eq!(err.code, PolymarketErrorCode::NetworkError);
    assert_eq!(err.message, "connection failed");
    assert!(err.cause.is_some());
}

#[test]
fn test_error_code_display() {
    assert_eq!(format!("{}", PolymarketErrorCode::InvalidMarket), "INVALID_MARKET");
    assert_eq!(format!("{}", PolymarketErrorCode::InvalidToken), "INVALID_TOKEN");
    assert_eq!(format!("{}", PolymarketErrorCode::InvalidOrder), "INVALID_ORDER");
    assert_eq!(format!("{}", PolymarketErrorCode::InsufficientFunds), "INSUFFICIENT_FUNDS");
    assert_eq!(format!("{}", PolymarketErrorCode::MarketClosed), "MARKET_CLOSED");
    assert_eq!(format!("{}", PolymarketErrorCode::ApiError), "API_ERROR");
    assert_eq!(format!("{}", PolymarketErrorCode::WebSocketError), "WEBSOCKET_ERROR");
    assert_eq!(format!("{}", PolymarketErrorCode::AuthError), "AUTH_ERROR");
    assert_eq!(format!("{}", PolymarketErrorCode::ConfigError), "CONFIG_ERROR");
    assert_eq!(format!("{}", PolymarketErrorCode::ClientNotInitialized), "CLIENT_NOT_INITIALIZED");
    assert_eq!(format!("{}", PolymarketErrorCode::ParseError), "PARSE_ERROR");
    assert_eq!(format!("{}", PolymarketErrorCode::NetworkError), "NETWORK_ERROR");
}

// ===========================================================================
// ProviderResult default tests
// ===========================================================================

#[test]
fn test_provider_result_default() {
    let result = ProviderResult::default();
    assert!(result.text.is_empty());
    assert!(result.values.is_object());
    assert!(result.data.is_object());
}

// ===========================================================================
// Plugin metadata tests
// ===========================================================================

#[test]
fn test_plugin_name() {
    assert_eq!(elizaos_plugin_polymarket::PLUGIN_NAME, "polymarket");
}

#[test]
fn test_plugin_version_not_empty() {
    assert!(!elizaos_plugin_polymarket::PLUGIN_VERSION.is_empty());
}

// ===========================================================================
// Helper: create a ClobClient for tests that don't need auth
// ===========================================================================

fn make_test_client() -> elizaos_plugin_polymarket::client::ClobClient {
    futures::executor::block_on(
        elizaos_plugin_polymarket::client::ClobClient::new(
            None,
            &format!("0x{}", "11".repeat(32)),
        ),
    )
    .expect("test client init")
}
