//! Keypair utilities and wallet configuration.

use crate::error::{SolanaError, SolanaResult};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use std::str::FromStr;

/// Wallet configuration loaded from environment or settings.
/// Note: Keypair doesn't implement Clone, so we store the secret bytes instead.
#[derive(Debug)]
pub struct WalletConfig {
    /// Solana RPC URL.
    pub rpc_url: String,
    /// Public key (always available).
    pub public_key: Pubkey,
    /// Private key bytes (optional, only needed for signing).
    keypair_bytes: Option<[u8; 64]>,
    /// Slippage tolerance in basis points.
    pub slippage_bps: u16,
    /// Helius API key (optional).
    pub helius_api_key: Option<String>,
    /// Birdeye API key (optional).
    pub birdeye_api_key: Option<String>,
}

impl Clone for WalletConfig {
    fn clone(&self) -> Self {
        Self {
            rpc_url: self.rpc_url.clone(),
            public_key: self.public_key,
            keypair_bytes: self.keypair_bytes,
            slippage_bps: self.slippage_bps,
            helius_api_key: self.helius_api_key.clone(),
            birdeye_api_key: self.birdeye_api_key.clone(),
        }
    }
}

impl WalletConfig {
    /// Create a new wallet configuration with just a public key (read-only).
    ///
    /// # Arguments
    /// * `rpc_url` - Solana RPC endpoint URL
    /// * `public_key` - Base58-encoded public key
    ///
    /// # Errors
    /// Returns an error if the public key is invalid.
    pub fn read_only(rpc_url: String, public_key: &str) -> SolanaResult<Self> {
        let pubkey = Pubkey::from_str(public_key)?;

        Ok(Self {
            rpc_url,
            public_key: pubkey,
            keypair_bytes: None,
            slippage_bps: 50,
            helius_api_key: None,
            birdeye_api_key: None,
        })
    }

    /// Create a new wallet configuration with a private key (full access).
    ///
    /// # Arguments
    /// * `rpc_url` - Solana RPC endpoint URL
    /// * `private_key` - Base58 or Base64-encoded private key
    ///
    /// # Errors
    /// Returns an error if the private key is invalid.
    pub fn with_keypair(rpc_url: String, private_key: &str) -> SolanaResult<Self> {
        let keypair = KeypairUtils::from_string(private_key)?;
        let public_key = keypair.pubkey();
        let keypair_bytes = keypair.to_bytes();

        Ok(Self {
            rpc_url,
            public_key,
            keypair_bytes: Some(keypair_bytes),
            slippage_bps: 50,
            helius_api_key: None,
            birdeye_api_key: None,
        })
    }

    /// Load configuration from environment variables.
    ///
    /// Reads the following environment variables:
    /// - `SOLANA_RPC_URL` (required)
    /// - `SOLANA_PRIVATE_KEY` or `WALLET_PRIVATE_KEY` (optional)
    /// - `SOLANA_PUBLIC_KEY` or `WALLET_PUBLIC_KEY` (required if no private key)
    /// - `SLIPPAGE` (optional, defaults to 50 bps)
    /// - `HELIUS_API_KEY` (optional)
    /// - `BIRDEYE_API_KEY` (optional)
    ///
    /// # Errors
    /// Returns an error if required variables are missing or invalid.
    pub fn from_env() -> SolanaResult<Self> {
        let rpc_url = std::env::var("SOLANA_RPC_URL")
            .map_err(|_| SolanaError::Config("SOLANA_RPC_URL is required".to_string()))?;

        // Try to get private key first
        let private_key = std::env::var("SOLANA_PRIVATE_KEY")
            .or_else(|_| std::env::var("WALLET_PRIVATE_KEY"))
            .ok();

        let (public_key, keypair_bytes) = if let Some(pk) = private_key {
            let kp = KeypairUtils::from_string(&pk)?;
            (kp.pubkey(), Some(kp.to_bytes()))
        } else {
            // Fall back to public key only
            let pubkey_str = std::env::var("SOLANA_PUBLIC_KEY")
                .or_else(|_| std::env::var("WALLET_PUBLIC_KEY"))
                .map_err(|_| {
                    SolanaError::Config(
                        "Either SOLANA_PRIVATE_KEY or SOLANA_PUBLIC_KEY is required".to_string(),
                    )
                })?;
            (Pubkey::from_str(&pubkey_str)?, None)
        };

        let slippage_bps = std::env::var("SLIPPAGE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(50);

        Ok(Self {
            rpc_url,
            public_key,
            keypair_bytes,
            slippage_bps,
            helius_api_key: std::env::var("HELIUS_API_KEY").ok(),
            birdeye_api_key: std::env::var("BIRDEYE_API_KEY").ok(),
        })
    }

    /// Set slippage tolerance.
    #[must_use]
    pub fn with_slippage(mut self, slippage_bps: u16) -> Self {
        self.slippage_bps = slippage_bps;
        self
    }

    /// Set Helius API key.
    #[must_use]
    pub fn with_helius_key(mut self, key: String) -> Self {
        self.helius_api_key = Some(key);
        self
    }

    /// Set Birdeye API key.
    #[must_use]
    pub fn with_birdeye_key(mut self, key: String) -> Self {
        self.birdeye_api_key = Some(key);
        self
    }

    /// Get the keypair if available.
    ///
    /// # Errors
    /// Returns an error if no private key is configured.
    pub fn keypair(&self) -> SolanaResult<Keypair> {
        self.keypair_bytes
            .as_ref()
            .map(|bytes| {
                Keypair::try_from(bytes.as_slice())
                    .expect("stored keypair bytes should be valid")
            })
            .ok_or_else(|| {
                SolanaError::Config("Private key not configured - read-only wallet".to_string())
            })
    }

    /// Check if this wallet can sign transactions.
    #[must_use]
    pub fn can_sign(&self) -> bool {
        self.keypair_bytes.is_some()
    }
}

/// Utility functions for working with Solana keypairs.
pub struct KeypairUtils;

impl KeypairUtils {
    /// Parse a keypair from a Base58 or Base64 encoded string.
    ///
    /// Tries Base58 first, then Base64 if that fails.
    ///
    /// # Arguments
    /// * `s` - The encoded private key string
    ///
    /// # Errors
    /// Returns an error if the string cannot be decoded as either format.
    pub fn from_string(s: &str) -> SolanaResult<Keypair> {
        // Try Base58 first
        if let Ok(bytes) = bs58::decode(s).into_vec() {
            if bytes.len() == 64 {
                return Keypair::try_from(bytes.as_slice())
                    .map_err(|e| SolanaError::InvalidKeypair(e.to_string()));
            }
        }

        // Try Base64
        if let Ok(bytes) = base64_decode(s) {
            if bytes.len() == 64 {
                return Keypair::try_from(bytes.as_slice())
                    .map_err(|e| SolanaError::InvalidKeypair(e.to_string()));
            }
        }

        Err(SolanaError::InvalidKeypair(
            "Invalid private key format - expected 64-byte Base58 or Base64 encoded key"
                .to_string(),
        ))
    }

    /// Generate a new random keypair.
    #[must_use]
    pub fn generate() -> Keypair {
        Keypair::new()
    }

    /// Convert a keypair to Base58-encoded string.
    #[must_use]
    pub fn to_base58(keypair: &Keypair) -> String {
        bs58::encode(keypair.to_bytes()).into_string()
    }

    /// Validate a public key string.
    ///
    /// # Arguments
    /// * `pubkey_str` - Base58-encoded public key
    ///
    /// # Returns
    /// `true` if the string is a valid Solana public key.
    pub fn is_valid_pubkey(pubkey_str: &str) -> bool {
        Pubkey::from_str(pubkey_str).is_ok()
    }

    /// Validate a public key and check if it's on the Ed25519 curve.
    ///
    /// On-curve keys are typically user wallets, while off-curve keys
    /// are Program Derived Addresses (PDAs).
    pub fn is_on_curve(pubkey_str: &str) -> SolanaResult<bool> {
        let pubkey = Pubkey::from_str(pubkey_str)?;
        Ok(pubkey.is_on_curve())
    }

    /// Detect public keys in arbitrary text.
    ///
    /// # Arguments
    /// * `text` - The text to search
    /// * `check_curve` - Whether to verify keys are on the Ed25519 curve
    ///
    /// # Returns
    /// A vector of detected public key strings.
    pub fn detect_pubkeys_in_text(text: &str, check_curve: bool) -> Vec<String> {
        let mut results = Vec::new();
        let re = regex::Regex::new(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
            .expect("regex should be valid");

        for cap in re.captures_iter(text) {
            let s = &cap[0];
            if let Ok(bytes) = bs58::decode(s).into_vec() {
                let bytes_len = bytes.len();
                if bytes_len == 32 {
                    if check_curve {
                        if let Ok(pubkey) = Pubkey::try_from(bytes.as_slice()) {
                            if pubkey.is_on_curve() {
                                results.push(s.to_string());
                            }
                        }
                    } else {
                        results.push(s.to_string());
                    }
                }
            }
        }

        results
    }
}

/// Simple Base64 decoder (no external crate needed).
fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn decode_char(c: u8) -> Option<u8> {
        ALPHABET.iter().position(|&x| x == c).map(|i| i as u8)
    }

    let s = s.trim_end_matches('=');
    let mut result = Vec::with_capacity(s.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for c in s.bytes() {
        let val = decode_char(c).ok_or(())?;
        buffer = (buffer << 6) | u32::from(val);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            result.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pubkey_validation() {
        assert!(KeypairUtils::is_valid_pubkey(
            "So11111111111111111111111111111111111111112"
        ));
        assert!(!KeypairUtils::is_valid_pubkey("invalid"));
        assert!(!KeypairUtils::is_valid_pubkey(""));
    }

    #[test]
    fn test_keypair_generation() {
        let kp = KeypairUtils::generate();
        let base58 = KeypairUtils::to_base58(&kp);
        assert!(!base58.is_empty());
    }

    #[test]
    fn test_detect_pubkeys() {
        let text = "Send to So11111111111111111111111111111111111111112 please";
        let keys = KeypairUtils::detect_pubkeys_in_text(text, false);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0], "So11111111111111111111111111111111111111112");
    }

    #[test]
    fn test_wallet_config_read_only() {
        let config = WalletConfig::read_only(
            "https://api.devnet.solana.com".to_string(),
            "So11111111111111111111111111111111111111112",
        );
        assert!(config.is_ok());
        let config = config.expect("config should be valid");
        assert!(!config.can_sign());
    }
}

