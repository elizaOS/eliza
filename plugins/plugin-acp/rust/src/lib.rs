//! elizaOS Plugin ACP - Rust Implementation
//!
//! Agentic Commerce Protocol (ACP) plugin for elizaOS.
//! Enables AI agents to interact with merchants for checkout and commerce.
//!
//! Based on https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
//!
//! # Features
//!
//! - `native` (default): Enables full async support with tokio and reqwest
//! - `wasm`: Enables WebAssembly support with JavaScript interop
//!
//! # Example
//!
//! ```rust,ignore
//! use elizaos_plugin_acp::{AcpClient, AcpClientConfig, CreateCheckoutSessionRequest, Item};
//!
//! #[tokio::main]
//! async fn main() -> anyhow::Result<()> {
//!     let config = AcpClientConfig::from_env()?;
//!     let client = AcpClient::new(config)?;
//!
//!     let request = CreateCheckoutSessionRequest {
//!         line_items: vec![Item {
//!             id: "item_123".to_string(),
//!             quantity: Some(2),
//!             ..Default::default()
//!         }],
//!         currency: "USD".to_string(),
//!         ..Default::default()
//!     };
//!
//!     let session = client.create_checkout_session(request, None).await?;
//!     println!("Created session: {}", session.id);
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod actions;
pub mod client;
pub mod config;
pub mod error;
pub mod providers;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export commonly used types for convenience
pub use client::AcpClient;
pub use config::AcpClientConfig;
pub use error::{AcpError, Result};
pub use types::{
    Address, AppliedDiscount, Buyer, CancelCheckoutSessionRequest, Capabilities, CheckoutSession,
    CheckoutSessionStatus, CompleteCheckoutSessionRequest, Coupon, CreateCheckoutSessionRequest,
    DiscountsRequest, DiscountsResponse, FulfillmentDetails, FulfillmentOption,
    FulfillmentOptionShipping, FulfillmentType, IntentTrace, IntentTraceReasonCode, Item,
    LineItem, Message, MessageSeverity, MessageType, Order, PaymentCredential, PaymentData,
    PaymentHandler, PaymentInstrument, SelectedFulfillmentOption, Total, TotalType,
    UpdateCheckoutSessionRequest,
};

/// Plugin metadata
pub const PLUGIN_NAME: &str = "acp";
/// Plugin description
pub const PLUGIN_DESCRIPTION: &str =
    "Agentic Commerce Protocol - enables AI agents to interact with merchants for checkout and commerce";
/// Plugin version
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Creates a runtime-native elizaOS plugin (`elizaos::Plugin`).
///
/// This is the interface expected by the Rust AgentRuntime plugin system.
pub fn plugin() -> elizaos::Plugin {
    elizaos::Plugin::new(PLUGIN_NAME, PLUGIN_DESCRIPTION)
}

/// Create an ACP client from environment variables.
///
/// # Errors
///
/// Returns an error if ACP_MERCHANT_BASE_URL is not set.
pub fn create_client_from_env() -> Result<AcpClient> {
    let config = AcpClientConfig::from_env()?;
    AcpClient::new(config)
}
