//! elizaOS TEE Plugin - Trusted Execution Environment Integration
//!
//! This crate provides TEE integration for secure key management and remote attestation.
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_tee::{TEEService, TeeMode};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let service = TEEService::start(Some("LOCAL"), None)?;
//!
//!     // Derive Ed25519 keypair (for Solana)
//!     let solana_result = service
//!         .derive_ed25519_keypair("my-salt", "solana", "agent-123")
//!         .await?;
//!     println!("Solana Public Key: {}", solana_result.public_key);
//!
//!     // Derive ECDSA keypair (for EVM)
//!     let evm_result = service
//!         .derive_ecdsa_keypair("my-salt", "evm", "agent-123")
//!         .await?;
//!     println!("EVM Address: {}", evm_result.address);
//!
//!     service.stop();
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod actions;
pub mod client;
pub mod error;
pub mod providers;
pub mod services;
pub mod types;
pub mod utils;
pub mod vendors;

// Re-export main types
pub use client::{upload_attestation_quote, TeeClient};
pub use error::{Result, TeeError};
pub use providers::{
    DeriveKeyProvider, PhalaDeriveKeyProvider, PhalaRemoteAttestationProvider,
    RemoteAttestationProvider,
};
pub use services::TEEService;
pub use types::{
    DeriveKeyAttestationData, DeriveKeyResult, EcdsaKeypairResult, Ed25519KeypairResult,
    RemoteAttestationMessage, RemoteAttestationQuote, TdxQuoteHashAlgorithm, TeeMode,
    TeeProviderResult, TeeServiceConfig, TeeType, TeeVendor,
};
pub use utils::{
    bytes_to_hex, calculate_keccak256, calculate_sha256, get_tee_endpoint, hex_to_bytes,
};
pub use vendors::{get_vendor, PhalaVendor, TeeVendorInterface, TeeVendorNames};

/// Plugin name.
pub const PLUGIN_NAME: &str = "tee";

/// Plugin description.
pub const PLUGIN_DESCRIPTION: &str =
    "Trusted Execution Environment (TEE) integration plugin for secure key management and remote attestation";

/// Plugin version.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

