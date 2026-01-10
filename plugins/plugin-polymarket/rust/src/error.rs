//! Error types for the Polymarket plugin

use std::fmt;
use thiserror::Error;

/// Polymarket-specific error codes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolymarketErrorCode {
    /// Invalid market identifier
    InvalidMarket,
    /// Invalid token identifier
    InvalidToken,
    /// Invalid order parameters
    InvalidOrder,
    /// Insufficient funds
    InsufficientFunds,
    /// Market is closed
    MarketClosed,
    /// API error
    ApiError,
    /// WebSocket error
    WebSocketError,
    /// Authentication error
    AuthError,
    /// Configuration error
    ConfigError,
    /// Client not initialized
    ClientNotInitialized,
    /// Parse error
    ParseError,
    /// Network error
    NetworkError,
}

impl fmt::Display for PolymarketErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::InvalidMarket => "INVALID_MARKET",
            Self::InvalidToken => "INVALID_TOKEN",
            Self::InvalidOrder => "INVALID_ORDER",
            Self::InsufficientFunds => "INSUFFICIENT_FUNDS",
            Self::MarketClosed => "MARKET_CLOSED",
            Self::ApiError => "API_ERROR",
            Self::WebSocketError => "WEBSOCKET_ERROR",
            Self::AuthError => "AUTH_ERROR",
            Self::ConfigError => "CONFIG_ERROR",
            Self::ClientNotInitialized => "CLIENT_NOT_INITIALIZED",
            Self::ParseError => "PARSE_ERROR",
            Self::NetworkError => "NETWORK_ERROR",
        };
        write!(f, "{s}")
    }
}

/// Polymarket error type
#[derive(Error, Debug)]
pub struct PolymarketError {
    /// Error code
    pub code: PolymarketErrorCode,
    /// Error message
    pub message: String,
    /// Optional underlying cause
    #[source]
    pub cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl PolymarketError {
    /// Create a new Polymarket error
    pub fn new(code: PolymarketErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
        }
    }

    /// Create a new error with a cause
    pub fn with_cause(
        code: PolymarketErrorCode,
        message: impl Into<String>,
        cause: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            cause: Some(Box::new(cause)),
        }
    }
}

impl fmt::Display for PolymarketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

// Convenience constructors
impl PolymarketError {
    /// Create an invalid market error
    pub fn invalid_market(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidMarket, message)
    }

    /// Create an invalid token error
    pub fn invalid_token(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidToken, message)
    }

    /// Create an invalid order error
    pub fn invalid_order(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidOrder, message)
    }

    /// Create an API error
    pub fn api_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::ApiError, message)
    }

    /// Create a config error
    pub fn config_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::ConfigError, message)
    }

    /// Create a network error
    pub fn network_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::NetworkError, message)
    }
}

/// Result type alias for Polymarket operations
pub type Result<T> = std::result::Result<T, PolymarketError>;

