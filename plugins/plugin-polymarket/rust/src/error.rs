#![allow(missing_docs)]
//! Error types for the Polymarket plugin

use std::fmt;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PolymarketErrorCode {
    InvalidMarket,
    InvalidToken,
    InvalidOrder,
    InsufficientFunds,
    MarketClosed,
    ApiError,
    WebSocketError,
    AuthError,
    ConfigError,
    ClientNotInitialized,
    ParseError,
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

#[derive(Error, Debug)]
pub struct PolymarketError {
    pub code: PolymarketErrorCode,
    pub message: String,
    #[source]
    pub cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl PolymarketError {
    pub fn new(code: PolymarketErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
        }
    }

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

impl PolymarketError {
    pub fn invalid_market(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidMarket, message)
    }

    pub fn invalid_token(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidToken, message)
    }

    pub fn invalid_order(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::InvalidOrder, message)
    }

    pub fn api_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::ApiError, message)
    }

    pub fn config_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::ConfigError, message)
    }

    pub fn network_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::NetworkError, message)
    }

    pub fn auth_error(message: impl Into<String>) -> Self {
        Self::new(PolymarketErrorCode::AuthError, message)
    }
}

pub type Result<T> = std::result::Result<T, PolymarketError>;
