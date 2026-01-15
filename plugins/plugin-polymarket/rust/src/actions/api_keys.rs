//! API Key Management Actions
//!
//! This module provides functions for managing Polymarket API keys:
//! - Creating API keys
//! - Listing all API keys
//! - Revoking API keys

use crate::client::ClobClient;
use crate::constants::POLYGON_CHAIN_ID;
use crate::error::{PolymarketError, Result};
use crate::types::{ApiKey, ApiKeyCreds};
use alloy::primitives::{keccak256, Address, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// EIP-712 domain name for Polymarket CLOB
const CLOB_DOMAIN_NAME: &str = "ClobAuthDomain";

/// EIP-712 domain version
const CLOB_DOMAIN_VERSION: &str = "1";

/// CLOB verifying contract address
const CLOB_VERIFYING_CONTRACT: &str = "0x0000000000000000000000000000000000000000";

/// EIP-712 type hash for ClobAuth message
fn clob_auth_type_hash() -> [u8; 32] {
    keccak256(b"ClobAuth(address address,uint256 timestamp,uint256 nonce)").into()
}

/// EIP-712 type hash for the domain
fn domain_type_hash() -> [u8; 32] {
    keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    )
    .into()
}

/// Request to create API key
#[derive(Debug, Serialize)]
struct CreateApiKeyRequest {
    address: String,
    timestamp: String,
    nonce: String,
    signature: String,
}

/// Response from create API key endpoint
#[derive(Debug, Deserialize)]
struct CreateApiKeyResponse {
    #[serde(rename = "apiKey")]
    api_key: String,
    secret: String,
    passphrase: String,
}

/// API key creator with EIP-712 signing
pub struct ApiKeyCreator {
    signer: PrivateKeySigner,
    base_url: String,
}

impl ApiKeyCreator {
    /// Create a new API key creator
    pub fn new(private_key: &str, base_url: Option<&str>) -> Result<Self> {
        let key = private_key.strip_prefix("0x").unwrap_or(private_key);
        let signer: PrivateKeySigner = key
            .parse()
            .map_err(|e| PolymarketError::config_error(format!("Invalid private key: {e}")))?;

        Ok(Self {
            signer,
            base_url: base_url
                .unwrap_or(crate::constants::DEFAULT_CLOB_API_URL)
                .trim_end_matches('/')
                .to_string(),
        })
    }

    /// Compute the EIP-712 domain separator for CLOB auth
    fn domain_separator(&self) -> [u8; 32] {
        let domain_type = domain_type_hash();
        let name_hash = keccak256(CLOB_DOMAIN_NAME.as_bytes());
        let version_hash = keccak256(CLOB_DOMAIN_VERSION.as_bytes());
        let chain_id = U256::from(POLYGON_CHAIN_ID);
        let verifying_contract: Address = CLOB_VERIFYING_CONTRACT.parse().unwrap();

        let mut data = Vec::with_capacity(160);
        data.extend_from_slice(&domain_type);
        data.extend_from_slice(name_hash.as_slice());
        data.extend_from_slice(version_hash.as_slice());
        data.extend_from_slice(&chain_id.to_be_bytes::<32>());
        data.extend_from_slice(verifying_contract.as_slice());

        keccak256(&data).into()
    }

    /// Compute the struct hash for ClobAuth message
    fn struct_hash(&self, address: Address, timestamp: U256, nonce: U256) -> [u8; 32] {
        let type_hash = clob_auth_type_hash();

        let mut data = Vec::with_capacity(128);
        data.extend_from_slice(&type_hash);
        data.extend_from_slice(&[0u8; 12]); // pad address to 32 bytes
        data.extend_from_slice(address.as_slice());
        data.extend_from_slice(&timestamp.to_be_bytes::<32>());
        data.extend_from_slice(&nonce.to_be_bytes::<32>());

        keccak256(&data).into()
    }

    /// Compute the EIP-712 hash for signing
    fn eip712_hash(&self, address: Address, timestamp: U256, nonce: U256) -> [u8; 32] {
        let domain_separator = self.domain_separator();
        let struct_hash = self.struct_hash(address, timestamp, nonce);

        let mut data = Vec::with_capacity(66);
        data.push(0x19);
        data.push(0x01);
        data.extend_from_slice(&domain_separator);
        data.extend_from_slice(&struct_hash);

        keccak256(&data).into()
    }

    /// Create a new API key
    pub async fn create_api_key(&self) -> Result<ApiKeyCreds> {
        let address = self.signer.address();

        // Get current timestamp
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Generate random nonce
        let nonce = timestamp ^ random_u64();

        let timestamp_u256 = U256::from(timestamp);
        let nonce_u256 = U256::from(nonce);

        // Compute EIP-712 hash
        let hash = self.eip712_hash(address, timestamp_u256, nonce_u256);

        // Sign the hash
        let signature = self
            .signer
            .sign_hash(&hash.into())
            .await
            .map_err(|e| PolymarketError::api_error(format!("Failed to sign: {e}")))?;

        let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));

        // Create request
        let request = CreateApiKeyRequest {
            address: format!("{:?}", address),
            timestamp: timestamp.to_string(),
            nonce: nonce.to_string(),
            signature: sig_hex,
        };

        // Submit to API
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| {
                PolymarketError::network_error(format!("Failed to create HTTP client: {e}"))
            })?;

        let url = format!("{}/auth/api-key", self.base_url);
        let response = client
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                PolymarketError::network_error(format!("Failed to create API key: {e}"))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(PolymarketError::api_error(format!(
                "Failed to create API key ({}): {}",
                status, error_text
            )));
        }

        let api_response: CreateApiKeyResponse = response.json().await.map_err(|e| {
            PolymarketError::api_error(format!("Failed to parse API key response: {e}"))
        })?;

        Ok(ApiKeyCreds {
            key: api_response.api_key,
            secret: api_response.secret,
            passphrase: api_response.passphrase,
        })
    }
}

/// Generate a pseudo-random u64 based on current time
fn random_u64() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    duration.as_nanos() as u64 ^ (duration.as_secs() << 32) ^ (std::process::id() as u64)
}

/// Create a new API key.
///
/// Creates a new API key using EIP-712 signature. The key credentials
/// will be returned and should be stored securely.
///
/// # Arguments
///
/// * `private_key` - The private key for signing
/// * `base_url` - Optional CLOB API URL
///
/// # Returns
///
/// API key credentials (key, secret, passphrase).
pub async fn create_api_key(private_key: &str, base_url: Option<&str>) -> Result<ApiKeyCreds> {
    let creator = ApiKeyCreator::new(private_key, base_url)?;
    creator.create_api_key().await
}

/// Get all API keys for the authenticated user.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
///
/// # Returns
///
/// List of API keys with their details.
pub async fn get_all_api_keys(client: &ClobClient) -> Result<Vec<ApiKey>> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required to list API keys",
        ));
    }

    client.get_api_keys().await
}

/// Revoke an API key.
///
/// # Arguments
///
/// * `client` - Authenticated CLOB client
/// * `key_id` - The API key ID to revoke
///
/// # Returns
///
/// `true` if the key was successfully revoked.
pub async fn revoke_api_key(client: &ClobClient, key_id: &str) -> Result<bool> {
    if !client.has_credentials() {
        return Err(PolymarketError::auth_error(
            "API credentials required to revoke API keys",
        ));
    }

    client.revoke_api_key(key_id).await
}

/// Get the current authentication status.
///
/// # Arguments
///
/// * `client` - CLOB client
///
/// # Returns
///
/// Tuple of (has_private_key, has_api_key, has_api_secret, has_api_passphrase, is_fully_authenticated)
pub fn get_authentication_status(client: &ClobClient) -> (bool, bool, bool, bool, bool) {
    // Private key is always required for client creation
    let has_private_key = true;

    // Check if credentials are set
    let has_creds = client.has_credentials();

    (
        has_private_key,
        has_creds,     // has_api_key
        has_creds,     // has_api_secret
        has_creds,     // has_api_passphrase
        has_creds,     // is_fully_authenticated
    )
}
