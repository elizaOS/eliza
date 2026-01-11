#![allow(missing_docs)]
//! TEE Service for elizaOS.

use tracing::{debug, info};

use crate::error::Result;
use crate::providers::derive_key::PhalaDeriveKeyProvider;
use crate::providers::DeriveKeyProvider;
use crate::types::{
    DeriveKeyResult, EcdsaKeypairResult, Ed25519KeypairResult, TeeMode, TeeServiceConfig, TeeVendor,
};

/// TEE Service for secure key management within a Trusted Execution Environment.
///
/// This service provides:
/// - Ed25519 key derivation (for Solana)
/// - ECDSA key derivation (for EVM chains)
/// - Raw key derivation for custom use cases
/// - Remote attestation for all derived keys
pub struct TEEService {
    provider: PhalaDeriveKeyProvider,
    /// Service configuration.
    pub config: TeeServiceConfig,
}

impl TEEService {
    /// Create a new TEE service.
    ///
    /// # Arguments
    ///
    /// * `config` - The service configuration.
    ///
    /// # Returns
    ///
    /// The service instance.
    ///
    /// # Errors
    ///
    /// Returns an error if the configuration is invalid.
    pub fn new(config: TeeServiceConfig) -> Result<Self> {
        let provider = PhalaDeriveKeyProvider::new(config.mode.as_str())?;

        info!(
            "TEE service initialized with mode: {}, vendor: {}",
            config.mode.as_str(),
            config.vendor.as_str()
        );

        Ok(Self { provider, config })
    }

    /// Start the TEE service with default configuration.
    ///
    /// # Arguments
    ///
    /// * `tee_mode` - The TEE operation mode.
    /// * `secret_salt` - Optional secret salt for key derivation.
    ///
    /// # Returns
    ///
    /// The service instance.
    pub fn start(tee_mode: Option<&str>, secret_salt: Option<String>) -> Result<Self> {
        let mode = match tee_mode {
            Some(m) => TeeMode::parse(m)?,
            None => TeeMode::Local,
        };

        info!("Starting TEE service with mode: {}", mode.as_str());

        let config = TeeServiceConfig {
            mode,
            vendor: TeeVendor::Phala,
            secret_salt,
        };

        Self::new(config)
    }

    /// Stop the TEE service.
    pub fn stop(&self) {
        info!("Stopping TEE service");
        // No cleanup needed currently
    }

    /// Service type identifier.
    pub const SERVICE_TYPE: &'static str = "tee";

    /// Service capability description.
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Trusted Execution Environment for secure key management";

    /// Derive an ECDSA keypair for EVM chains.
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path (e.g., secret salt).
    /// * `subject` - The subject for the certificate chain (e.g., "evm").
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
        debug!("TEE Service: Deriving ECDSA keypair");
        self.provider.derive_ecdsa_keypair(path, subject, agent_id).await
    }

    /// Derive an Ed25519 keypair for Solana.
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path (e.g., secret salt).
    /// * `subject` - The subject for the certificate chain (e.g., "solana").
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
        debug!("TEE Service: Deriving Ed25519 keypair");
        self.provider.derive_ed25519_keypair(path, subject, agent_id).await
    }

    /// Derive a raw key for custom use cases.
    ///
    /// # Arguments
    ///
    /// * `path` - The derivation path.
    /// * `subject` - The subject for the certificate chain.
    ///
    /// # Returns
    ///
    /// The raw key derivation result.
    pub async fn raw_derive_key(&self, path: &str, subject: &str) -> Result<DeriveKeyResult> {
        debug!("TEE Service: Deriving raw key");
        self.provider.raw_derive_key(path, subject).await
    }
}







