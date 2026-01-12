#![deny(unsafe_code)]
#![forbid(clippy::unwrap_used)]
#![allow(deprecated)] // solana_sdk::system_instruction deprecation

pub mod actions;
pub mod client;
pub mod error;
pub mod keypair;
pub mod providers;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use actions::{SwapAction, TransferAction};
pub use client::SolanaClient;
pub use error::{SolanaError, SolanaResult};
pub use keypair::{KeypairUtils, WalletConfig};
pub use providers::WalletProvider;
pub use service::{SolanaService, SolanaWalletService, SOLANA_SERVICE_NAME};
pub use types::SwapQuoteParams;

pub const PLUGIN_NAME: &str = "chain_solana";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_RPC_URL: &str = "https://api.mainnet-beta.solana.com";
pub const WRAPPED_SOL_MINT: &str = "So11111111111111111111111111111111111111112";
pub const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
