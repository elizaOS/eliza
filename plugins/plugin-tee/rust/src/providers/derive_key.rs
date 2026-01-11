#![allow(missing_docs)]
//! Key Derivation Provider for Phala TEE.

use async_trait::async_trait;
use bs58;
use ed25519_dalek::{SigningKey, VerifyingKey};
use k256::ecdsa::SigningKey as K256SigningKey;
use tracing::{debug, info};

use crate::client::TeeClient;
use crate::error::{Result, TeeError};
use crate::providers::base::{DeriveKeyProvider, RemoteAttestationProvider};
use crate::providers::remote_attestation::PhalaRemoteAttestationProvider;
use crate::types::{
    DeriveKeyAttestationData, DeriveKeyResult, EcdsaKeypairResult, Ed25519KeypairResult,
    RemoteAttestationQuote,
};
use crate::utils::{calculate_keccak256, calculate_sha256, get_tee_endpoint};

/// Phala Network Key Derivation Provider.
///
/// Derives cryptographic keys within the TEE using Phala's DStack SDK.
pub struct PhalaDeriveKeyProvider {
    client: TeeClient,
    ra_provider: PhalaRemoteAttestationProvider,
}

impl PhalaDeriveKeyProvider {
    /// Create a new Phala key derivation provider.
    ///
    /// # Arguments
    ///
    /// * `tee_mode` - The TEE operation mode (LOCAL, DOCKER, PRODUCTION).
    ///
    /// # Returns
    ///
    /// The provider instance.
    ///
    /// # Errors
    ///
    /// Returns an error if the mode is invalid.
    pub fn new(tee_mode: &str) -> Result<Self> {
        let endpoint = get_tee_endpoint(tee_mode)?;

        if let Some(ref ep) = endpoint {
            info!("TEE: Connecting to key derivation service at {}", ep);
        } else {
            info!("TEE: Running key derivation in production mode");
        }

        Ok(Self {
            client: TeeClient::new(endpoint),
            ra_provider: PhalaRemoteAttestationProvider::new(tee_mode)?,
        })
    }

    /// Generate attestation for derived key.
    async fn generate_derive_key_attestation(
        &self,
        agent_id: &str,
        public_key: &str,
        subject: Option<&str>,
    ) -> Result<RemoteAttestationQuote> {
        let derive_key_data = DeriveKeyAttestationData {
            agent_id: agent_id.to_string(),
            public_key: public_key.to_string(),
            subject: subject.map(|s| s.to_string()),
        };

        debug!("Generating attestation for derived key...");
        let report_data = serde_json::to_string(&derive_key_data)?;
        let quote = self.ra_provider.generate_attestation(&report_data, None).await?;
        info!("Key derivation attestation generated successfully");
        Ok(quote)
    }

    /// Derive an Ed25519 keypair (for Solana).
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path.
    /// * `subject` - The subject for the certificate chain.
    /// * `agent_id` - The agent ID for attestation.
    ///
    /// # Returns
    ///
    /// The keypair result with public key, secret key, and attestation.
    pub async fn derive_ed25519_keypair(
        &self,
        path: &str,
        subject: &str,
        agent_id: &str,
    ) -> Result<Ed25519KeypairResult> {
        if path.is_empty() || subject.is_empty() {
            return Err(TeeError::key_derivation(
                "Path and subject are required for key derivation",
            ));
        }

        debug!("Deriving Ed25519 key in TEE...");

        let derived_key = self.client.derive_key(path, subject).await?;

        // Hash the derived key to get a proper 32-byte seed
        let seed = calculate_sha256(&derived_key);
        let seed_array: [u8; 32] = seed[..32]
            .try_into()
            .map_err(|_| TeeError::crypto("Failed to create seed array"))?;

        // Create Ed25519 keypair from seed
        let signing_key = SigningKey::from_bytes(&seed_array);
        let verifying_key: VerifyingKey = (&signing_key).into();
        let public_key = bs58::encode(verifying_key.as_bytes()).into_string();

        // Generate attestation for the derived public key
        let attestation = self
            .generate_derive_key_attestation(agent_id, &public_key, Some(subject))
            .await?;

        info!("Ed25519 key derived successfully");

        Ok(Ed25519KeypairResult {
            public_key,
            secret_key: signing_key.to_bytes().to_vec(),
            attestation,
        })
    }

    /// Derive an ECDSA keypair (for EVM).
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path.
    /// * `subject` - The subject for the certificate chain.
    /// * `agent_id` - The agent ID for attestation.
    ///
    /// # Returns
    ///
    /// The keypair result with address, private key, and attestation.
    pub async fn derive_ecdsa_keypair(
        &self,
        path: &str,
        subject: &str,
        agent_id: &str,
    ) -> Result<EcdsaKeypairResult> {
        if path.is_empty() || subject.is_empty() {
            return Err(TeeError::key_derivation(
                "Path and subject are required for key derivation",
            ));
        }

        debug!("Deriving ECDSA key in TEE...");

        let derived_key = self.client.derive_key(path, subject).await?;

        // Use keccak256 hash of derived key as private key
        let private_key_bytes = calculate_keccak256(&derived_key);
        let private_key_array: [u8; 32] = private_key_bytes[..32]
            .try_into()
            .map_err(|_| TeeError::crypto("Failed to create private key array"))?;

        // Create secp256k1 signing key
        let signing_key = K256SigningKey::from_bytes(&private_key_array.into())
            .map_err(|e| TeeError::crypto(e.to_string()))?;

        // Get public key and derive address
        let public_key = signing_key.verifying_key();
        let public_key_bytes = public_key.to_encoded_point(false);
        let public_key_hash = calculate_keccak256(&public_key_bytes.as_bytes()[1..]);
        let address_bytes = &public_key_hash[12..];
        let address = format!("0x{}", hex::encode(address_bytes));

        // Generate attestation for the derived address
        let attestation = self
            .generate_derive_key_attestation(agent_id, &address, Some(subject))
            .await?;

        info!("ECDSA key derived successfully");

        Ok(EcdsaKeypairResult {
            address,
            private_key: private_key_bytes,
            attestation,
        })
    }
}

#[async_trait]
impl DeriveKeyProvider for PhalaDeriveKeyProvider {
    async fn raw_derive_key(&self, path: &str, subject: &str) -> Result<DeriveKeyResult> {
        if path.is_empty() || subject.is_empty() {
            return Err(TeeError::key_derivation(
                "Path and subject are required for key derivation",
            ));
        }

        debug!("Deriving raw key in TEE...");
        let key = self.client.derive_key(path, subject).await?;

        info!("Raw key derived successfully");

        Ok(DeriveKeyResult {
            key,
            certificate_chain: vec![],
        })
    }
}





