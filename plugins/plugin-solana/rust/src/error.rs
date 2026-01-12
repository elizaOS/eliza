#![allow(missing_docs)]

use thiserror::Error;

pub type SolanaResult<T> = Result<T, SolanaError>;

#[derive(Error, Debug)]
pub enum SolanaError {
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Invalid keypair: {0}")]
    InvalidKeypair(String),
    #[error("Invalid public key: {0}")]
    InvalidPublicKey(String),
    #[error("Invalid mint address: {0}")]
    InvalidMint(String),
    #[error("RPC error: {0}")]
    Rpc(String),
    #[error("Transaction error: {0}")]
    Transaction(String),
    #[error("Simulation failed: {0}")]
    SimulationFailed(String),
    #[error("Transaction confirmation timeout: {0}")]
    ConfirmationTimeout(String),
    #[error("Insufficient balance: required {required}, available {available}")]
    InsufficientBalance { required: u64, available: u64 },
    #[error("Token account not found for mint {mint}")]
    TokenAccountNotFound { mint: String },
    #[error("Swap quote error: {0}")]
    SwapQuote(String),
    #[error("Swap execution error: {0}")]
    SwapExecution(String),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Base58 decode error: {0}")]
    Base58(#[from] bs58::decode::Error),
    #[error("Solana SDK error: {0}")]
    Sdk(String),
    #[error("Rate limited: {0}")]
    RateLimited(String),
    #[error("Account not found: {0}")]
    AccountNotFound(String),
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
