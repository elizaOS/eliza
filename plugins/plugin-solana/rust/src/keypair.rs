#![allow(missing_docs)]

use crate::error::{SolanaError, SolanaResult};
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use std::str::FromStr;

#[derive(Debug)]
pub struct WalletConfig {
    pub rpc_url: String,
    pub public_key: Pubkey,
    keypair_bytes: Option<[u8; 64]>,
    pub slippage_bps: u16,
    pub helius_api_key: Option<String>,
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

    pub fn from_env() -> SolanaResult<Self> {
        let rpc_url = std::env::var("SOLANA_RPC_URL")
            .map_err(|_| SolanaError::Config("SOLANA_RPC_URL is required".to_string()))?;

        let private_key = std::env::var("SOLANA_PRIVATE_KEY")
            .or_else(|_| std::env::var("WALLET_PRIVATE_KEY"))
            .ok();

        let (public_key, keypair_bytes) = if let Some(pk) = private_key {
            let kp = KeypairUtils::from_string(&pk)?;
            (kp.pubkey(), Some(kp.to_bytes()))
        } else {
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

    pub fn from_env_or_generate<F>(store_callback: Option<F>) -> SolanaResult<Self>
    where
        F: Fn(&str, &str, bool),
    {
        let rpc_url =
            std::env::var("SOLANA_RPC_URL").unwrap_or_else(|_| crate::DEFAULT_RPC_URL.to_string());

        let private_key = std::env::var("SOLANA_PRIVATE_KEY")
            .or_else(|_| std::env::var("WALLET_PRIVATE_KEY"))
            .ok();

        let (public_key, keypair_bytes) = if let Some(pk) = private_key {
            let kp = KeypairUtils::from_string(&pk)?;
            (kp.pubkey(), Some(kp.to_bytes()))
        } else {
            let pubkey_result =
                std::env::var("SOLANA_PUBLIC_KEY").or_else(|_| std::env::var("WALLET_PUBLIC_KEY"));

            if let Ok(pubkey_str) = pubkey_result {
                (Pubkey::from_str(&pubkey_str)?, None)
            } else {
                let kp = KeypairUtils::generate();
                let public_key = kp.pubkey();
                let private_key_base58 = KeypairUtils::to_base58(&kp);
                let public_key_base58 = public_key.to_string();

                if let Some(ref callback) = store_callback {
                    callback("SOLANA_PRIVATE_KEY", &private_key_base58, true);
                    callback("SOLANA_PUBLIC_KEY", &public_key_base58, false);
                }

                tracing::warn!("No Solana wallet found. Generated new wallet automatically.");
                tracing::warn!("New Solana wallet address: {}", public_key_base58);
                tracing::warn!("Private key has been stored securely in agent settings.");
                tracing::warn!("Fund this wallet to enable SOL and token transfers.");

                (public_key, Some(kp.to_bytes()))
            }
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

    #[must_use]
    pub fn with_slippage(mut self, slippage_bps: u16) -> Self {
        self.slippage_bps = slippage_bps;
        self
    }

    #[must_use]
    pub fn with_helius_key(mut self, key: String) -> Self {
        self.helius_api_key = Some(key);
        self
    }

    #[must_use]
    pub fn with_birdeye_key(mut self, key: String) -> Self {
        self.birdeye_api_key = Some(key);
        self
    }

    pub fn keypair(&self) -> SolanaResult<Keypair> {
        self.keypair_bytes
            .as_ref()
            .map(|bytes| {
                Keypair::try_from(bytes.as_slice()).expect("stored keypair bytes should be valid")
            })
            .ok_or_else(|| {
                SolanaError::Config("Private key not configured - read-only wallet".to_string())
            })
    }

    #[must_use]
    pub fn can_sign(&self) -> bool {
        self.keypair_bytes.is_some()
    }
}

pub struct KeypairUtils;

impl KeypairUtils {
    pub fn from_string(s: &str) -> SolanaResult<Keypair> {
        if let Ok(bytes) = bs58::decode(s).into_vec() {
            if bytes.len() == 64 {
                return Keypair::try_from(bytes.as_slice())
                    .map_err(|e| SolanaError::InvalidKeypair(e.to_string()));
            }
        }

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

    #[must_use]
    pub fn generate() -> Keypair {
        Keypair::new()
    }

    #[must_use]
    pub fn to_base58(keypair: &Keypair) -> String {
        bs58::encode(keypair.to_bytes()).into_string()
    }

    pub fn is_valid_pubkey(pubkey_str: &str) -> bool {
        Pubkey::from_str(pubkey_str).is_ok()
    }

    pub fn is_on_curve(pubkey_str: &str) -> SolanaResult<bool> {
        let pubkey = Pubkey::from_str(pubkey_str)?;
        Ok(pubkey.is_on_curve())
    }

    pub fn detect_pubkeys_in_text(text: &str, check_curve: bool) -> Vec<String> {
        let mut results = Vec::new();
        let re =
            regex::Regex::new(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b").expect("regex should be valid");

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

    pub fn detect_private_keys_in_text(text: &str) -> Vec<(String, String)> {
        let mut results = Vec::new();

        let base58_re =
            regex::Regex::new(r"\b[1-9A-HJ-NP-Za-km-z]{86,90}\b").expect("regex should be valid");

        for cap in base58_re.captures_iter(text) {
            let s = &cap[0];
            if let Ok(bytes) = bs58::decode(s).into_vec() {
                if bytes.len() == 64 {
                    results.push(("base58".to_string(), s.to_string()));
                }
            }
        }

        let hex_re = regex::Regex::new(r"\b[a-fA-F0-9]{128}\b").expect("regex should be valid");

        for cap in hex_re.captures_iter(text) {
            let s = &cap[0];
            if let Ok(bytes) = hex::decode(s) {
                if bytes.len() == 64 {
                    results.push(("hex".to_string(), s.to_string()));
                }
            }
        }

        results
    }
}

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

    #[test]
    fn test_detect_private_keys_base58() {
        // Generate a keypair and encode it
        let kp = KeypairUtils::generate();
        let base58_key = KeypairUtils::to_base58(&kp);
        let text = format!("My private key is {}", base58_key);

        let keys = KeypairUtils::detect_private_keys_in_text(&text);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].0, "base58");
        assert_eq!(keys[0].1, base58_key);
    }

    #[test]
    fn test_detect_private_keys_hex() {
        // Generate a keypair and encode it as hex
        let kp = KeypairUtils::generate();
        let hex_key = hex::encode(kp.to_bytes());
        let text = format!("Hex key: {}", hex_key);

        let keys = KeypairUtils::detect_private_keys_in_text(&text);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].0, "hex");
        assert_eq!(keys[0].1, hex_key);
    }

    #[test]
    fn test_detect_private_keys_none() {
        let text = "This text contains no private keys, just a pubkey So11111111111111111111111111111111111111112";
        let keys = KeypairUtils::detect_private_keys_in_text(text);
        assert!(keys.is_empty());
    }
}
