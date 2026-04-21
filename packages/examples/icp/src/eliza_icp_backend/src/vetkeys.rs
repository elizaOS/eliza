//! VetKeys Integration for Secure Key Derivation
//!
//! This module provides integration with ICP's vetKD (verifiably encrypted threshold
//! Key Derivation) system for secure cryptographic key management.
//!
//! ## Use Cases
//!
//! - **Encrypted Storage**: Derive keys to encrypt sensitive data in stable memory
//! - **User-Specific Keys**: Derive unique keys per user for personalized encryption
//! - **Session Keys**: Generate temporary session keys for secure communication
//! - **API Key Encryption**: Encrypt API keys stored by the canister (e.g., OpenAI keys)
//!
//! ## How it Works
//!
//! 1. Canister requests a derived key from the vetKD system
//! 2. User provides a transport public key for secure delivery
//! 3. VetKD subnet derives and encrypts the key
//! 4. Only the user with the matching private key can decrypt
//!
//! ## Security Notes
//!
//! - Keys are never exposed in plaintext on-chain
//! - Each derived key is deterministic for the same (canister, context, input)
//! - VetKD master keys are threshold-shared among subnet nodes
//!
//! ## Local vs Mainnet
//!
//! - Local: Uses chainkey_testing_canister for development
//! - Mainnet: Uses the management canister's vetkd APIs

use crate::types::{CanisterError, CanisterResult, EncryptedVetKey, VetKeyContext};
use candid::{CandidType, Principal};
use ic_cdk::api::call::call;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

// ========== VetKD System Canister ID ==========

thread_local! {
    /// The canister ID of the vetKD system API (chainkey_testing_canister for local dev)
    /// This should be set during canister initialization
    static VETKD_CANISTER_ID: RefCell<Option<Principal>> = const { RefCell::new(None) };
}

/// Set the vetKD system canister ID (call this during init)
pub fn set_vetkd_canister_id(canister_id: Principal) {
    VETKD_CANISTER_ID.with(|id| *id.borrow_mut() = Some(canister_id));
}

/// Get the vetKD system canister ID
fn get_vetkd_canister_id() -> Principal {
    VETKD_CANISTER_ID.with(|id| {
        id.borrow().unwrap_or_else(|| {
            // Fallback to management canister (for mainnet)
            Principal::management_canister()
        })
    })
}

// ========== VetKD System API Types ==========

/// VetKD Master Key ID
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VetKdKeyId {
    pub curve: VetKdCurve,
    pub name: String,
}

/// Supported elliptic curves for vetKD
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub enum VetKdCurve {
    #[serde(rename = "bls12_381_g2")]
    Bls12381G2,
}

/// Arguments for vetkd_public_key
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VetKdPublicKeyArgs {
    pub canister_id: Option<Principal>,
    pub derivation_path: Vec<Vec<u8>>,
    pub key_id: VetKdKeyId,
}

/// Response from vetkd_public_key
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VetKdPublicKeyResponse {
    pub public_key: Vec<u8>,
}

/// Arguments for vetkd_derive_encrypted_key
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VetKdEncryptedKeyArgs {
    pub key_id: VetKdKeyId,
    pub derivation_path: Vec<Vec<u8>>,
    pub derivation_id: Vec<u8>,
    pub encryption_public_key: Vec<u8>,
}

/// Response from vetkd_encrypted_key
#[derive(Clone, Debug, CandidType, Serialize, Deserialize)]
pub struct VetKdEncryptedKeyResponse {
    pub encrypted_key: Vec<u8>,
}

// ========== VetKeys Manager ==========

/// VetKeys manager for the canister
pub struct VetKeysManager {
    /// The key ID to use for derivation
    key_id: VetKdKeyId,
}

impl VetKeysManager {
    /// Create a new VetKeys manager
    ///
    /// # Arguments
    /// * `key_name` - Name of the vetKD key to use
    ///   - For local testing: "insecure_test_key_1"
    ///   - For mainnet: "key_1" or "test_key_1"
    pub fn new(key_name: &str) -> Self {
        Self {
            key_id: VetKdKeyId {
                curve: VetKdCurve::Bls12381G2,
                name: key_name.to_string(),
            },
        }
    }
    
    /// Create a manager with the local testing key
    pub fn for_local_testing() -> Self {
        Self::new("insecure_test_key_1")
    }
    
    /// Create a manager with the mainnet key
    pub fn for_mainnet() -> Self {
        Self::new("key_1")
    }

    /// Get the canister's vetKD public key
    ///
    /// This public key can be used to verify encrypted keys and
    /// for public key derivation off-chain.
    pub async fn get_public_key(&self, context: &[u8]) -> CanisterResult<Vec<u8>> {
        let args = VetKdPublicKeyArgs {
            canister_id: None, // Use this canister's ID
            derivation_path: vec![context.to_vec()],
            key_id: self.key_id.clone(),
        };

        let vetkd_canister = get_vetkd_canister_id();
        
        let (response,): (VetKdPublicKeyResponse,) = call(
            vetkd_canister,
            "vetkd_public_key",
            (args,),
        )
        .await
        .map_err(|(code, msg)| {
            CanisterError::VetKeyError(format!(
                "Failed to get public key from {:?}: code={:?}, msg={}",
                vetkd_canister, code, msg
            ))
        })?;

        Ok(response.public_key)
    }

    /// Derive an encrypted key for a user
    ///
    /// # Arguments
    /// * `context` - Context for key derivation (domain separator)
    /// * `derivation_id` - Unique ID for this key (e.g., user ID, session ID)
    /// * `transport_public_key` - User's public key for encrypting the derived key
    ///
    /// # Returns
    /// The encrypted derived key that only the user can decrypt
    pub async fn derive_encrypted_key(
        &self,
        context: &[u8],
        derivation_id: &[u8],
        transport_public_key: &[u8],
    ) -> CanisterResult<EncryptedVetKey> {
        let args = VetKdEncryptedKeyArgs {
            key_id: self.key_id.clone(),
            derivation_path: vec![context.to_vec()],
            derivation_id: derivation_id.to_vec(),
            encryption_public_key: transport_public_key.to_vec(),
        };

        let vetkd_canister = get_vetkd_canister_id();
        
        let (response,): (VetKdEncryptedKeyResponse,) = call(
            vetkd_canister,
            "vetkd_derive_encrypted_key",
            (args,),
        )
        .await
        .map_err(|(code, msg)| {
            CanisterError::VetKeyError(format!(
                "Failed to derive encrypted key from {:?}: code={:?}, msg={}",
                vetkd_canister, code, msg
            ))
        })?;

        // Get the public key for verification
        let public_key = self.get_public_key(context).await?;

        Ok(EncryptedVetKey {
            encrypted_key: response.encrypted_key,
            public_key,
            context: VetKeyContext {
                purpose: String::from_utf8_lossy(context).to_string(),
                domain: Some(String::from_utf8_lossy(derivation_id).to_string()),
            },
        })
    }

    /// Derive a key for encrypting user-specific data
    ///
    /// # Arguments
    /// * `user_principal` - The user's principal ID
    /// * `transport_public_key` - User's public key for encryption
    pub async fn derive_user_encryption_key(
        &self,
        user_principal: &Principal,
        transport_public_key: &[u8],
    ) -> CanisterResult<EncryptedVetKey> {
        let context = b"user_encryption";
        let derivation_id = user_principal.as_slice();

        self.derive_encrypted_key(context, derivation_id, transport_public_key)
            .await
    }

    /// Derive a key for a specific purpose
    ///
    /// # Arguments
    /// * `purpose` - The purpose of the key (e.g., "api_key_encryption", "session")
    /// * `identifier` - Unique identifier within the purpose
    /// * `transport_public_key` - Public key for encryption
    pub async fn derive_purpose_key(
        &self,
        purpose: &str,
        identifier: &str,
        transport_public_key: &[u8],
    ) -> CanisterResult<EncryptedVetKey> {
        let context = format!("eliza_{}", purpose);
        let derivation_id = identifier.as_bytes();

        self.derive_encrypted_key(context.as_bytes(), derivation_id, transport_public_key)
            .await
    }
}

// ========== Key Derivation Contexts ==========

/// Standard contexts for key derivation
pub mod contexts {
    /// Context for encrypting stored memories
    pub const MEMORY_ENCRYPTION: &[u8] = b"eliza_memory_encryption";

    /// Context for encrypting API credentials
    pub const API_CREDENTIALS: &[u8] = b"eliza_api_credentials";

    /// Context for session keys
    pub const SESSION_KEY: &[u8] = b"eliza_session";

    /// Context for user-specific encryption
    pub const USER_DATA: &[u8] = b"eliza_user_data";
}

// ========== Helper Functions ==========

/// Check if vetKD is available on the current subnet
///
/// Note: vetKD is only available on specific subnets. This function
/// attempts a public key request to check availability.
pub async fn is_vetkd_available() -> bool {
    let manager = VetKeysManager::for_local_testing();
    manager.get_public_key(b"test").await.is_ok()
}

/// Generate a random derivation ID
pub fn generate_derivation_id() -> Vec<u8> {
    use sha2::{Digest, Sha256};

    let time = ic_cdk::api::time();
    let caller = ic_cdk::api::caller();

    let mut hasher = Sha256::new();
    hasher.update(time.to_be_bytes());
    hasher.update(caller.as_slice());
    hasher.update(b"derivation_id");

    hasher.finalize().to_vec()
}

// ========== Usage Example ==========
//
// ```rust
// // In your canister:
//
// use crate::vetkeys::{VetKeysManager, contexts};
//
// // Get encrypted key for a user
// async fn get_user_key(user_transport_key: Vec<u8>) -> Result<EncryptedVetKey, String> {
//     let manager = VetKeysManager::new("key_1");
//     let caller = ic_cdk::api::caller();
//     
//     manager.derive_user_encryption_key(&caller, &user_transport_key)
//         .await
//         .map_err(|e| e.to_string())
// }
//
// // The user can then decrypt this key client-side using their private key
// // and use it to encrypt/decrypt their data
// ```
