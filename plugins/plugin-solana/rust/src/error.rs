//! Error types for the Solana plugin.

use thiserror::Error;

/// Result type for Solana operations.
pub type SolanaResult<T> = Result<T, SolanaError>;

/// Errors that can occur during Solana operations.
#[derive(Error, Debug)]
pub enum SolanaError {
    /// Configuration error - missing or invalid settings.
    #[error("Configuration error: {0}")]
    Config(String),

    /// Invalid keypair or key format.
    #[error("Invalid keypair: {0}")]
    InvalidKeypair(String),

    /// Invalid public key format.
    #[error("Invalid public key: {0}")]
    InvalidPublicKey(String),

    /// Invalid mint address.
    #[error("Invalid mint address: {0}")]
    InvalidMint(String),

    /// RPC connection error.
    #[error("RPC error: {0}")]
    Rpc(String),

    /// Transaction error.
    #[error("Transaction error: {0}")]
    Transaction(String),

    /// Transaction simulation failed.
    #[error("Simulation failed: {0}")]
    SimulationFailed(String),

    /// Transaction confirmation timeout.
    #[error("Transaction confirmation timeout: {0}")]
    ConfirmationTimeout(String),

    /// Insufficient balance for operation.
    #[error("Insufficient balance: required {required}, available {available}")]
    InsufficientBalance {
        /// Required amount in lamports.
        required: u64,
        /// Available amount in lamports.
        available: u64,
    },

    /// Token account not found.
    #[error("Token account not found for mint {mint}")]
    TokenAccountNotFound {
        /// The mint address that was not found.
        mint: String,
    },

    /// Swap quote error.
    #[error("Swap quote error: {0}")]
    SwapQuote(String),

    /// Swap execution error.
    #[error("Swap execution error: {0}")]
    SwapExecution(String),

    /// HTTP request error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON parsing error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Base58 decoding error.
    #[error("Base58 decode error: {0}")]
    Base58(#[from] bs58::decode::Error),

    /// Solana SDK error.
    #[error("Solana SDK error: {0}")]
    Sdk(String),

    /// Rate limited by RPC or API.
    #[error("Rate limited: {0}")]
    RateLimited(String),

    /// Account not found.
    #[error("Account not found: {0}")]
    AccountNotFound(String),

    /// Internal error.
    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<solana_sdk::pubkey::ParsePubkeyError> for SolanaError {
    fn from(e: solana_sdk::pubkey::ParsePubkeyError) -> Self {
        SolanaError::InvalidPublicKey(e.to_string())
    }
}

impl From<solana_sdk::signature::SignerError> for SolanaError {
    fn from(e: solana_sdk::signature::SignerError) -> Self {
        SolanaError::InvalidKeypair(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = SolanaError::Config("missing RPC URL".to_string());
        assert_eq!(err.to_string(), "Configuration error: missing RPC URL");

        let err = SolanaError::InsufficientBalance {
            required: 1000000000,
            available: 500000000,
        };
        assert!(err.to_string().contains("Insufficient balance"));
    }
}


