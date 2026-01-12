#![allow(missing_docs)]

use crate::client::SolanaClient;
use crate::error::SolanaResult;
use crate::keypair::WalletConfig;
use crate::providers::{WalletProvider, WalletProviderResult};

pub const SOLANA_SERVICE_NAME: &str = "chain_solana";

/// Minimal service wrapper for Solana (TS parity: `SolanaService`).
pub struct SolanaService {
    client: SolanaClient,
}

impl SolanaService {
    pub const SERVICE_TYPE: &'static str = SOLANA_SERVICE_NAME;
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Interact with the Solana blockchain and access wallet data";

    pub fn new(client: SolanaClient) -> Self {
        Self { client }
    }

    pub fn from_env_or_generate() -> SolanaResult<Self> {
        let config = WalletConfig::from_env_or_generate::<fn(&str, &str, bool)>(None)?;
        let client = SolanaClient::new(config)?;
        Ok(Self::new(client))
    }

    #[must_use]
    pub fn client(&self) -> &SolanaClient {
        &self.client
    }

    pub async fn get_wallet_portfolio(
        &self,
        agent_name: Option<&str>,
    ) -> Result<WalletProviderResult, String> {
        WalletProvider::get(&self.client, agent_name).await
    }
}

/// Minimal wallet service wrapper (TS parity: `SolanaWalletService`).
pub struct SolanaWalletService {
    solana: SolanaService,
}

impl SolanaWalletService {
    pub const SERVICE_TYPE: &'static str = "WALLET";
    pub const CAPABILITY_DESCRIPTION: &'static str =
        "Provides standardized access to Solana wallet balances and portfolios";

    pub fn new(solana: SolanaService) -> Self {
        Self { solana }
    }

    #[must_use]
    pub fn solana_service(&self) -> &SolanaService {
        &self.solana
    }
}
