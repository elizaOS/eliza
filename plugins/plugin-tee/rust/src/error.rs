#![allow(missing_docs)]

use thiserror::Error;

pub type Result<T> = std::result::Result<T, TeeError>;

#[derive(Debug, Error)]
pub enum TeeError {
    #[error("Configuration error: {0}")]
    Config(String),

    #[error("Invalid TEE_MODE: {0}. Must be one of: LOCAL, DOCKER, PRODUCTION")]
    InvalidMode(String),

    #[error("Invalid TEE_VENDOR: {0}. Must be one of: phala")]
    InvalidVendor(String),

    #[error("Failed to generate attestation: {0}")]
    Attestation(String),

    #[error("Failed to derive key: {0}")]
    KeyDerivation(String),

    #[error("Network error: {0}")]
    Network(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Hex decoding error: {0}")]
    HexDecode(#[from] hex::FromHexError),

    #[error("Cryptographic error: {0}")]
    Crypto(String),
}

impl TeeError {
    pub fn config<S: Into<String>>(msg: S) -> Self {
        Self::Config(msg.into())
    }

    pub fn attestation<S: Into<String>>(msg: S) -> Self {
        Self::Attestation(msg.into())
    }

    pub fn key_derivation<S: Into<String>>(msg: S) -> Self {
        Self::KeyDerivation(msg.into())
    }

    pub fn network<S: Into<String>>(msg: S) -> Self {
        Self::Network(msg.into())
    }

    pub fn crypto<S: Into<String>>(msg: S) -> Self {
        Self::Crypto(msg.into())
    }
}
