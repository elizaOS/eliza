#![allow(missing_docs)]

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EVMErrorCode {
    InsufficientFunds,
    UserRejected,
    NetworkError,
    ContractRevert,
    GasEstimationFailed,
    InvalidParams,
    ChainNotConfigured,
    WalletNotInitialized,
    TransactionFailed,
    TokenNotFound,
    RouteNotFound,
    ApprovalFailed,
}

impl fmt::Display for EVMErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InsufficientFunds => write!(f, "INSUFFICIENT_FUNDS"),
            Self::UserRejected => write!(f, "USER_REJECTED"),
            Self::NetworkError => write!(f, "NETWORK_ERROR"),
            Self::ContractRevert => write!(f, "CONTRACT_REVERT"),
            Self::GasEstimationFailed => write!(f, "GAS_ESTIMATION_FAILED"),
            Self::InvalidParams => write!(f, "INVALID_PARAMS"),
            Self::ChainNotConfigured => write!(f, "CHAIN_NOT_CONFIGURED"),
            Self::WalletNotInitialized => write!(f, "WALLET_NOT_INITIALIZED"),
            Self::TransactionFailed => write!(f, "TRANSACTION_FAILED"),
            Self::TokenNotFound => write!(f, "TOKEN_NOT_FOUND"),
            Self::RouteNotFound => write!(f, "ROUTE_NOT_FOUND"),
            Self::ApprovalFailed => write!(f, "APPROVAL_FAILED"),
        }
    }
}

#[derive(Debug)]
pub struct EVMError {
    pub code: EVMErrorCode,
    pub message: String,
    pub source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl EVMError {
    #[must_use]
    pub fn new(code: EVMErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }

    #[must_use]
    pub fn with_source<E>(code: EVMErrorCode, message: impl Into<String>, source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            code,
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    #[must_use]
    pub fn insufficient_funds(message: impl Into<String>) -> Self {
        Self::new(EVMErrorCode::InsufficientFunds, message)
    }

    #[must_use]
    pub fn chain_not_configured(chain: &str) -> Self {
        Self::new(
            EVMErrorCode::ChainNotConfigured,
            format!("Chain '{chain}' is not configured"),
        )
    }

    #[must_use]
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(EVMErrorCode::InvalidParams, message)
    }

    #[must_use]
    pub fn wallet_not_initialized() -> Self {
        Self::new(EVMErrorCode::WalletNotInitialized, "Wallet not initialized")
    }

    #[must_use]
    pub fn transaction_failed(message: impl Into<String>) -> Self {
        Self::new(EVMErrorCode::TransactionFailed, message)
    }

    #[must_use]
    pub fn network_error(message: impl Into<String>) -> Self {
        Self::new(EVMErrorCode::NetworkError, message)
    }
}

impl fmt::Display for EVMError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for EVMError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|e| e.as_ref() as &(dyn std::error::Error + 'static))
    }
}

impl From<reqwest::Error> for EVMError {
    fn from(err: reqwest::Error) -> Self {
        Self::with_source(
            EVMErrorCode::NetworkError,
            format!("HTTP request failed: {err}"),
            err,
        )
    }
}

impl From<serde_json::Error> for EVMError {
    fn from(err: serde_json::Error) -> Self {
        Self::with_source(
            EVMErrorCode::InvalidParams,
            format!("JSON parsing failed: {err}"),
            err,
        )
    }
}

impl From<url::ParseError> for EVMError {
    fn from(err: url::ParseError) -> Self {
        Self::with_source(
            EVMErrorCode::InvalidParams,
            format!("URL parsing failed: {err}"),
            err,
        )
    }
}

pub type EVMResult<T> = Result<T, EVMError>;
