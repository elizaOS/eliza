//! Wallet provider implementation using alloy-rs
//!
//! Provides wallet functionality for EVM chains including:
//! - Key management with local signer
//! - Client creation for each chain
//! - Balance queries
//! - Transaction signing and sending
//! - Automatic key generation when not provided

use alloy::{
    hex,
    network::{Ethereum, EthereumWallet},
    primitives::{Address, U256},
    providers::{
        fillers::{
            BlobGasFiller, ChainIdFiller, FillProvider, GasFiller, JoinFill, NonceFiller,
            WalletFiller,
        },
        Identity, Provider, ProviderBuilder, RootProvider,
    },
    signers::local::PrivateKeySigner,
    transports::http::{Client, Http},
};
use std::collections::HashMap;

use crate::constants::DEFAULT_DECIMALS;
use crate::error::{EVMError, EVMErrorCode, EVMResult};
use crate::types::{format_amount, ChainConfig, SupportedChain, WalletBalance};

/// Configuration for creating a wallet provider
#[derive(Debug, Clone)]
pub struct WalletProviderConfig {
    /// Private key (hex encoded with 0x prefix)
    pub private_key: String,
    /// Chains to configure
    pub chains: Vec<ChainConfig>,
}

impl WalletProviderConfig {
    /// Create a new configuration
    #[must_use]
    pub fn new(private_key: impl Into<String>) -> Self {
        Self {
            private_key: private_key.into(),
            chains: Vec::new(),
        }
    }

    /// Add a chain to the configuration
    #[must_use]
    pub fn with_chain(mut self, chain: SupportedChain, rpc_url: Option<String>) -> Self {
        self.chains.push(ChainConfig::new(chain, rpc_url));
        self
    }

    /// Add multiple chains with default RPCs
    #[must_use]
    pub fn with_chains(mut self, chains: &[SupportedChain]) -> Self {
        for chain in chains {
            self.chains.push(ChainConfig::new(*chain, None));
        }
        self
    }
}

/// Full provider type with all fillers (matches alloy 0.8+ recommended fillers)
pub type FullProvider = FillProvider<
    JoinFill<
        JoinFill<
            Identity,
            JoinFill<GasFiller, JoinFill<BlobGasFiller, JoinFill<NonceFiller, ChainIdFiller>>>,
        >,
        WalletFiller<EthereumWallet>,
    >,
    RootProvider<Http<Client>>,
    Http<Client>,
    Ethereum,
>;

/// Wallet provider for EVM chains
///
/// Manages wallet access, chain configuration, and balance queries.
pub struct WalletProvider {
    /// Local signer
    signer: PrivateKeySigner,
    /// Ethereum wallet
    wallet: EthereumWallet,
    /// Providers for each chain (with wallet filler)
    providers: HashMap<SupportedChain, FullProvider>,
    /// Chain configurations
    configs: HashMap<SupportedChain, ChainConfig>,
}

impl WalletProvider {
    /// Create a new wallet provider
    ///
    /// # Arguments
    ///
    /// * `config` - Wallet provider configuration
    ///
    /// # Errors
    ///
    /// Returns an error if the private key is invalid or provider creation fails
    pub async fn new(config: WalletProviderConfig) -> EVMResult<Self> {
        // Parse the private key
        let signer = config
            .private_key
            .parse::<PrivateKeySigner>()
            .map_err(|e| {
                EVMError::new(
                    EVMErrorCode::InvalidParams,
                    format!("Invalid private key: {e}"),
                )
            })?;

        let wallet = EthereumWallet::from(signer.clone());

        // Create providers for each chain
        let mut providers = HashMap::new();
        let mut configs = HashMap::new();

        for chain_config in config.chains {
            let url: url::Url = chain_config.rpc_url.parse().map_err(|e| {
                EVMError::new(
                    EVMErrorCode::InvalidParams,
                    format!("Invalid RPC URL for {}: {e}", chain_config.chain),
                )
            })?;

            let provider = ProviderBuilder::new()
                .with_recommended_fillers()
                .wallet(wallet.clone())
                .on_http(url);

            providers.insert(chain_config.chain, provider);
            configs.insert(chain_config.chain, chain_config);
        }

        Ok(Self {
            signer,
            wallet,
            providers,
            configs,
        })
    }

    /// Get the wallet address
    #[must_use]
    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Get the signer
    #[must_use]
    pub fn signer(&self) -> &PrivateKeySigner {
        &self.signer
    }

    /// Get the wallet
    #[must_use]
    pub fn wallet(&self) -> &EthereumWallet {
        &self.wallet
    }

    /// Get supported chains
    #[must_use]
    pub fn supported_chains(&self) -> Vec<SupportedChain> {
        self.configs.keys().copied().collect()
    }

    /// Check if a chain is configured
    #[must_use]
    pub fn has_chain(&self, chain: SupportedChain) -> bool {
        self.providers.contains_key(&chain)
    }

    /// Get the provider for a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured
    pub fn provider(&self, chain: SupportedChain) -> EVMResult<&FullProvider> {
        self.providers
            .get(&chain)
            .ok_or_else(|| EVMError::chain_not_configured(&chain.to_string()))
    }

    /// Get the chain configuration
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured
    pub fn chain_config(&self, chain: SupportedChain) -> EVMResult<&ChainConfig> {
        self.configs
            .get(&chain)
            .ok_or_else(|| EVMError::chain_not_configured(&chain.to_string()))
    }

    /// Get the native token balance for a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured or RPC call fails
    pub async fn get_balance(&self, chain: SupportedChain) -> EVMResult<U256> {
        let provider = self.provider(chain)?;
        let address = self.address();

        provider.get_balance(address).await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::NetworkError,
                format!("Failed to get balance for {chain}: {e}"),
            )
        })
    }

    /// Get formatted native token balance for a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured or RPC call fails
    pub async fn get_formatted_balance(&self, chain: SupportedChain) -> EVMResult<String> {
        let balance = self.get_balance(chain).await?;
        Ok(format_amount(balance, DEFAULT_DECIMALS))
    }

    /// Get balances for all configured chains
    ///
    /// # Errors
    ///
    /// Returns an error if any RPC call fails
    pub async fn get_all_balances(&self) -> EVMResult<Vec<WalletBalance>> {
        let mut balances = Vec::new();
        let address = self.address();

        for chain in self.supported_chains() {
            match self.get_formatted_balance(chain).await {
                Ok(native_balance) => {
                    balances.push(WalletBalance {
                        chain,
                        address,
                        native_balance,
                        tokens: Vec::new(),
                    });
                }
                Err(e) => {
                    tracing::warn!("Failed to get balance for {chain}: {e}");
                }
            }
        }

        Ok(balances)
    }

    /// Get the current nonce for the wallet on a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured or RPC call fails
    pub async fn get_nonce(&self, chain: SupportedChain) -> EVMResult<u64> {
        let provider = self.provider(chain)?;
        let address = self.address();

        provider
            .get_transaction_count(address)
            .await
            .map_err(|e| {
                EVMError::new(
                    EVMErrorCode::NetworkError,
                    format!("Failed to get nonce for {chain}: {e}"),
                )
            })
    }

    /// Get the current gas price for a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured or RPC call fails
    pub async fn get_gas_price(&self, chain: SupportedChain) -> EVMResult<u128> {
        let provider = self.provider(chain)?;

        provider.get_gas_price().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::NetworkError,
                format!("Failed to get gas price for {chain}: {e}"),
            )
        })
    }

    /// Get the chain ID for a chain
    ///
    /// # Errors
    ///
    /// Returns an error if the chain is not configured or RPC call fails
    pub async fn get_chain_id(&self, chain: SupportedChain) -> EVMResult<u64> {
        let provider = self.provider(chain)?;

        provider.get_chain_id().await.map_err(|e| {
            EVMError::new(
                EVMErrorCode::NetworkError,
                format!("Failed to get chain ID for {chain}: {e}"),
            )
        })
    }
}

impl std::fmt::Debug for WalletProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletProvider")
            .field("address", &self.address())
            .field("chains", &self.supported_chains())
            .finish()
    }
}

/// Result of auto-generating a private key
#[derive(Debug, Clone)]
pub struct GeneratedKey {
    /// The generated private key (hex-encoded with 0x prefix)
    pub private_key: String,
    /// The corresponding wallet address
    pub address: Address,
}

/// Generate a new random private key and return it with the corresponding address.
///
/// This function generates a cryptographically secure random private key that can be
/// used to initialize a wallet provider.
///
/// # Example
///
/// ```rust
/// use elizaos_plugin_evm::providers::wallet::generate_private_key;
///
/// let generated = generate_private_key();
/// println!("Generated wallet address: {}", generated.address);
/// println!("Private key (keep secret!): {}", generated.private_key);
/// ```
#[must_use]
pub fn generate_private_key() -> GeneratedKey {
    let signer = PrivateKeySigner::random();
    let address = signer.address();
    let private_key = format!("0x{}", hex::encode(signer.to_bytes()));

    tracing::warn!("═══════════════════════════════════════════════════════════════════");
    tracing::warn!("⚠️  No private key provided - generating new wallet");
    tracing::warn!("📍 New wallet address: {}", address);
    tracing::warn!("💾 Please save the private key securely!");
    tracing::warn!("⚠️  IMPORTANT: Back up your private key for production use!");
    tracing::warn!("═══════════════════════════════════════════════════════════════════");

    GeneratedKey {
        private_key,
        address,
    }
}

impl WalletProviderConfig {
    /// Create a new configuration, generating a private key if not provided.
    ///
    /// If `private_key` is `None`, a new random key will be generated and a warning
    /// will be logged.
    ///
    /// # Returns
    ///
    /// A tuple of (config, generated_key) where `generated_key` is `Some` if a new
    /// key was generated.
    #[must_use]
    pub fn new_or_generate(private_key: Option<String>) -> (Self, Option<GeneratedKey>) {
        match private_key {
            Some(key) if !key.is_empty() => (Self::new(key), None),
            _ => {
                let generated = generate_private_key();
                (Self::new(generated.private_key.clone()), Some(generated))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_private_key() -> String {
        // Generate a random private key for testing
        let key = PrivateKeySigner::random();
        format!("0x{}", hex::encode(key.to_bytes()))
    }

    #[tokio::test]
    async fn test_wallet_provider_creation() {
        let config = WalletProviderConfig::new(test_private_key())
            .with_chain(SupportedChain::Sepolia, None);

        let provider = WalletProvider::new(config).await.unwrap();

        assert!(provider.has_chain(SupportedChain::Sepolia));
        assert!(!provider.has_chain(SupportedChain::Mainnet));
    }

    #[tokio::test]
    async fn test_wallet_address() {
        let config = WalletProviderConfig::new(test_private_key());
        let provider = WalletProvider::new(config).await.unwrap();

        let address = provider.address();
        assert!(!address.is_zero());
    }

    #[tokio::test]
    async fn test_auto_generate_private_key() {
        let (config, generated) = WalletProviderConfig::new_or_generate(None);
        
        assert!(generated.is_some(), "Should generate a key when None provided");
        
        let generated = generated.unwrap();
        assert!(generated.private_key.starts_with("0x"), "Key should have 0x prefix");
        assert_eq!(generated.private_key.len(), 66, "Key should be 66 chars (0x + 64 hex)");
        assert!(!generated.address.is_zero(), "Address should not be zero");
        
        // Should be able to create a provider with the generated key
        let provider = WalletProvider::new(config).await.unwrap();
        assert_eq!(provider.address(), generated.address);
    }

    #[tokio::test]
    async fn test_provided_key_not_regenerated() {
        let original_key = test_private_key();
        let (config, generated) = WalletProviderConfig::new_or_generate(Some(original_key.clone()));
        
        assert!(generated.is_none(), "Should not generate when key provided");
        
        let provider = WalletProvider::new(config).await.unwrap();
        let expected_signer: PrivateKeySigner = original_key.parse().unwrap();
        assert_eq!(provider.address(), expected_signer.address());
    }
}
