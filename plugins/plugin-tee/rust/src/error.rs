//! Error types for the TEE plugin.

use thiserror::Error;

/// Result type for TEE operations.
pub type Result<T> = std::result::Result<T, TeeError>;

/// Error types for TEE operations.
#[derive(Debug, Error)]
pub enum TeeError {
    /// Configuration error.
    #[error("Configuration error: {0}")]
    Config(String),

    /// Invalid TEE mode.
    #[error("Invalid TEE_MODE: {0}. Must be one of: LOCAL, DOCKER, PRODUCTION")]
    InvalidMode(String),

    /// Invalid TEE vendor.
    #[error("Invalid TEE_VENDOR: {0}. Must be one of: phala")]
    InvalidVendor(String),

    /// Remote attestation error.
    #[error("Failed to generate attestation: {0}")]
    Attestation(String),

    /// Key derivation error.
    #[error("Failed to derive key: {0}")]
    KeyDerivation(String),

    /// Network communication error.
    #[error("Network error: {0}")]
    Network(String),

    /// HTTP request error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Hex decoding error.
    #[error("Hex decoding error: {0}")]
    HexDecode(#[from] hex::FromHexError),

    /// Cryptographic error.
    #[error("Cryptographic error: {0}")]
    Crypto(String),
}

impl TeeError {
    /// Create a configuration error.
    pub fn config<S: Into<String>>(msg: S) -> Self {
        Self::Config(msg.into())
    }

    /// Create an attestation error.
    pub fn attestation<S: Into<String>>(msg: S) -> Self {
        Self::Attestation(msg.into())
    }

    /// Create a key derivation error.
    pub fn key_derivation<S: Into<String>>(msg: S) -> Self {
        Self::KeyDerivation(msg.into())
    }

    /// Create a network error.
    pub fn network<S: Into<String>>(msg: S) -> Self {
        Self::Network(msg.into())
    }

    /// Create a crypto error.
    pub fn crypto<S: Into<String>>(msg: S) -> Self {
        Self::Crypto(msg.into())
    }
}


