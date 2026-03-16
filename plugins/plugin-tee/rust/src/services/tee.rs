#![allow(missing_docs)]

use tracing::info;

use crate::error::Result;
use crate::providers::derive_key::PhalaDeriveKeyProvider;
use crate::providers::DeriveKeyProvider;
use crate::types::{
    DeriveKeyResult, EcdsaKeypairResult, Ed25519KeypairResult, TeeMode, TeeServiceConfig, TeeVendor,
};

pub struct TEEService {
    provider: PhalaDeriveKeyProvider,
    pub config: TeeServiceConfig,
}

impl TEEService {
    pub fn new(config: TeeServiceConfig) -> Result<Self> {
        let provider = PhalaDeriveKeyProvider::new(config.mode.as_str())?;

        info!(
            "TEE service initialized with mode: {}, vendor: {}",
            config.mode.as_str(),
            config.vendor.as_str()
        );

        Ok(Self { provider, config })
    }

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

    pub fn stop(&self) {
        info!("Stopping TEE service");
    }

    pub const SERVICE_TYPE: &'static str = "tee";
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Trusted Execution Environment for secure key management";

    pub async fn derive_ecdsa_keypair(
        &self,
        path: &str,
        subject: &str,
        agent_id: &str,
    ) -> Result<EcdsaKeypairResult> {
        self.provider
            .derive_ecdsa_keypair(path, subject, agent_id)
            .await
    }

    pub async fn derive_ed25519_keypair(
        &self,
        path: &str,
        subject: &str,
        agent_id: &str,
    ) -> Result<Ed25519KeypairResult> {
        self.provider
            .derive_ed25519_keypair(path, subject, agent_id)
            .await
    }

    pub async fn raw_derive_key(&self, path: &str, subject: &str) -> Result<DeriveKeyResult> {
        self.provider.raw_derive_key(path, subject).await
    }
}
