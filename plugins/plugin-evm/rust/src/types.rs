//! Type definitions for the EVM plugin
//!
//! This module provides strongly typed definitions for all EVM operations.
//! Types are designed for fail-fast validation - no defensive programming.

use alloy::primitives::{Address, Bytes, U256, B256};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use crate::error::{EVMError, EVMErrorCode};

// =============================================================================
// Chain Types
// =============================================================================

/// Supported EVM chain identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportedChain {
    /// Ethereum Mainnet
    Mainnet,
    /// Sepolia Testnet
    Sepolia,
    /// Base
    Base,
    /// Base Sepolia Testnet
    BaseSepolia,
    /// Arbitrum One
    Arbitrum,
    /// Optimism
    Optimism,
    /// Polygon
    Polygon,
    /// Avalanche C-Chain
    Avalanche,
    /// BNB Smart Chain
    Bsc,
    /// Gnosis Chain
    Gnosis,
    /// Fantom Opera
    Fantom,
    /// Linea
    Linea,
    /// Scroll
    Scroll,
    /// zkSync Era
    Zksync,
}

impl SupportedChain {
    /// Get the chain ID for this chain
    #[must_use]
    pub const fn chain_id(&self) -> u64 {
        match self {
            Self::Mainnet => 1,
            Self::Sepolia => 11155111,
            Self::Base => 8453,
            Self::BaseSepolia => 84532,
            Self::Arbitrum => 42161,
            Self::Optimism => 10,
            Self::Polygon => 137,
            Self::Avalanche => 43114,
            Self::Bsc => 56,
            Self::Gnosis => 100,
            Self::Fantom => 250,
            Self::Linea => 59144,
            Self::Scroll => 534352,
            Self::Zksync => 324,
        }
    }

    /// Get the native currency symbol for this chain
    #[must_use]
    pub const fn native_symbol(&self) -> &'static str {
        match self {
            Self::Mainnet | Self::Sepolia | Self::Base | Self::BaseSepolia
            | Self::Arbitrum | Self::Optimism | Self::Linea | Self::Scroll
            | Self::Zksync => "ETH",
            Self::Polygon => "MATIC",
            Self::Avalanche => "AVAX",
            Self::Bsc => "BNB",
            Self::Gnosis => "xDAI",
            Self::Fantom => "FTM",
        }
    }

    /// Get the default RPC URL for this chain
    #[must_use]
    pub const fn default_rpc(&self) -> &'static str {
        match self {
            Self::Mainnet => "https://eth.llamarpc.com",
            Self::Sepolia => "https://ethereum-sepolia-rpc.publicnode.com",
            Self::Base => "https://mainnet.base.org",
            Self::BaseSepolia => "https://sepolia.base.org",
            Self::Arbitrum => "https://arb1.arbitrum.io/rpc",
            Self::Optimism => "https://mainnet.optimism.io",
            Self::Polygon => "https://polygon-rpc.com",
            Self::Avalanche => "https://api.avax.network/ext/bc/C/rpc",
            Self::Bsc => "https://bsc-dataseed.binance.org",
            Self::Gnosis => "https://rpc.gnosischain.com",
            Self::Fantom => "https://rpc.ftm.tools",
            Self::Linea => "https://rpc.linea.build",
            Self::Scroll => "https://rpc.scroll.io",
            Self::Zksync => "https://mainnet.era.zksync.io",
        }
    }

    /// Check if this is a testnet
    #[must_use]
    pub const fn is_testnet(&self) -> bool {
        matches!(self, Self::Sepolia | Self::BaseSepolia)
    }
}

impl fmt::Display for SupportedChain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Mainnet => "mainnet",
            Self::Sepolia => "sepolia",
            Self::Base => "base",
            Self::BaseSepolia => "baseSepolia",
            Self::Arbitrum => "arbitrum",
            Self::Optimism => "optimism",
            Self::Polygon => "polygon",
            Self::Avalanche => "avalanche",
            Self::Bsc => "bsc",
            Self::Gnosis => "gnosis",
            Self::Fantom => "fantom",
            Self::Linea => "linea",
            Self::Scroll => "scroll",
            Self::Zksync => "zksync",
        };
        write!(f, "{name}")
    }
}

impl FromStr for SupportedChain {
    type Err = EVMError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "mainnet" | "ethereum" | "eth" => Ok(Self::Mainnet),
            "sepolia" => Ok(Self::Sepolia),
            "base" => Ok(Self::Base),
            "basesepolia" | "base_sepolia" | "base-sepolia" => Ok(Self::BaseSepolia),
            "arbitrum" | "arb" => Ok(Self::Arbitrum),
            "optimism" | "op" => Ok(Self::Optimism),
            "polygon" | "matic" => Ok(Self::Polygon),
            "avalanche" | "avax" => Ok(Self::Avalanche),
            "bsc" | "bnb" => Ok(Self::Bsc),
            "gnosis" | "xdai" => Ok(Self::Gnosis),
            "fantom" | "ftm" => Ok(Self::Fantom),
            "linea" => Ok(Self::Linea),
            "scroll" => Ok(Self::Scroll),
            "zksync" | "era" => Ok(Self::Zksync),
            _ => Err(EVMError::new(
                EVMErrorCode::ChainNotConfigured,
                format!("Unknown chain: {s}"),
            )),
        }
    }
}

// =============================================================================
// Transaction Types
// =============================================================================

/// Represents a completed transaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    /// Transaction hash
    pub hash: B256,
    /// Sender address
    pub from: Address,
    /// Recipient address
    pub to: Address,
    /// Value transferred in wei
    pub value: U256,
    /// Transaction data
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Bytes>,
    /// Chain ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<u64>,
}

/// Transaction receipt with confirmation status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionReceipt {
    /// Transaction hash
    pub hash: B256,
    /// Block number
    pub block_number: u64,
    /// Gas used
    pub gas_used: U256,
    /// Status (true = success)
    pub status: bool,
}

// =============================================================================
// Token Types
// =============================================================================

/// Token information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenInfo {
    /// Token address
    pub address: Address,
    /// Token symbol
    pub symbol: String,
    /// Token name
    pub name: String,
    /// Token decimals
    pub decimals: u8,
    /// Chain ID
    pub chain_id: u64,
    /// Logo URI (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_uri: Option<String>,
}

/// Token with balance information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenWithBalance {
    /// Token information
    pub token: TokenInfo,
    /// Raw balance in smallest unit
    pub balance: U256,
    /// Formatted balance as string
    pub formatted_balance: String,
    /// Price in USD (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<String>,
    /// Value in USD (optional)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_usd: Option<String>,
}

/// Wallet balance for a specific chain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletBalance {
    /// Chain
    pub chain: SupportedChain,
    /// Wallet address
    pub address: Address,
    /// Native token balance
    pub native_balance: String,
    /// Token balances
    pub tokens: Vec<TokenWithBalance>,
}

// =============================================================================
// Governance Types
// =============================================================================

/// Vote type for governance
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum VoteType {
    /// Vote against the proposal
    Against = 0,
    /// Vote for the proposal
    For = 1,
    /// Abstain from voting
    Abstain = 2,
}

impl From<u8> for VoteType {
    fn from(value: u8) -> Self {
        match value {
            0 => Self::Against,
            1 => Self::For,
            _ => Self::Abstain,
        }
    }
}

/// Governance proposal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    /// Target contract addresses
    pub targets: Vec<Address>,
    /// ETH values to send
    pub values: Vec<U256>,
    /// Encoded function calls
    pub calldatas: Vec<Bytes>,
    /// Proposal description
    pub description: String,
}

/// Vote parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteParams {
    /// Chain to execute on
    pub chain: SupportedChain,
    /// Governor contract address
    pub governor: Address,
    /// Proposal ID
    pub proposal_id: U256,
    /// Vote support type
    pub support: VoteType,
}

// =============================================================================
// Chain Configuration
// =============================================================================

/// Chain configuration with RPC URL
#[derive(Debug, Clone)]
pub struct ChainConfig {
    /// Chain identifier
    pub chain: SupportedChain,
    /// RPC URL
    pub rpc_url: String,
    /// Explorer URL (optional)
    pub explorer_url: Option<String>,
}

impl ChainConfig {
    /// Create a new chain configuration
    #[must_use]
    pub fn new(chain: SupportedChain, rpc_url: Option<String>) -> Self {
        Self {
            chain,
            rpc_url: rpc_url.unwrap_or_else(|| chain.default_rpc().to_string()),
            explorer_url: None,
        }
    }

    /// Set the explorer URL
    #[must_use]
    pub fn with_explorer(mut self, url: String) -> Self {
        self.explorer_url = Some(url);
        self
    }
}

// =============================================================================
// Amount Parsing
// =============================================================================

/// Parse an amount string to U256 with the given decimals
///
/// # Errors
///
/// Returns an error if the amount cannot be parsed
pub fn parse_amount(amount: &str, decimals: u8) -> Result<U256, EVMError> {
    let parts: Vec<&str> = amount.split('.').collect();

    let (integer_part, decimal_part) = match parts.len() {
        1 => (parts[0], ""),
        2 => (parts[0], parts[1]),
        _ => {
            return Err(EVMError::new(
                EVMErrorCode::InvalidParams,
                format!("Invalid amount format: {amount}"),
            ))
        }
    };

    // Pad or truncate decimal part to match decimals
    let decimal_str = if decimal_part.len() > decimals as usize {
        &decimal_part[..decimals as usize]
    } else {
        decimal_part
    };

    let padding = decimals as usize - decimal_str.len();
    let full_amount = format!("{integer_part}{decimal_str}{}", "0".repeat(padding));

    U256::from_str(&full_amount).map_err(|e| {
        EVMError::new(
            EVMErrorCode::InvalidParams,
            format!("Failed to parse amount: {e}"),
        )
    })
}

/// Format a U256 amount with the given decimals
#[must_use]
pub fn format_amount(amount: U256, decimals: u8) -> String {
    let divisor = U256::from(10).pow(U256::from(decimals));

    if divisor.is_zero() {
        return amount.to_string();
    }

    let integer_part = amount / divisor;
    let decimal_part = amount % divisor;

    if decimal_part.is_zero() {
        integer_part.to_string()
    } else {
        let decimal_str = format!("{:0>width$}", decimal_part, width = decimals as usize);
        let trimmed = decimal_str.trim_end_matches('0');
        format!("{integer_part}.{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chain_from_str() {
        assert_eq!("mainnet".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
        assert_eq!("ethereum".parse::<SupportedChain>().unwrap(), SupportedChain::Mainnet);
        assert_eq!("base".parse::<SupportedChain>().unwrap(), SupportedChain::Base);
        assert!("invalid".parse::<SupportedChain>().is_err());
    }

    #[test]
    fn test_chain_id() {
        assert_eq!(SupportedChain::Mainnet.chain_id(), 1);
        assert_eq!(SupportedChain::Base.chain_id(), 8453);
        assert_eq!(SupportedChain::Arbitrum.chain_id(), 42161);
    }

    #[test]
    fn test_parse_amount() {
        let result = parse_amount("1.5", 18).unwrap();
        assert_eq!(result, U256::from(1_500_000_000_000_000_000u128));

        let result = parse_amount("100", 6).unwrap();
        assert_eq!(result, U256::from(100_000_000u64));
    }

    #[test]
    fn test_format_amount() {
        let amount = U256::from(1_500_000_000_000_000_000u128);
        assert_eq!(format_amount(amount, 18), "1.5");

        let amount = U256::from(100_000_000u64);
        assert_eq!(format_amount(amount, 6), "100");
    }
}


