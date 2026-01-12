//! elizaOS Core - Rust Implementation
//!
//! This crate provides the core runtime and types for elizaOS, a framework for building
//! AI agents. It is designed to be fully compatible with the TypeScript implementation,
//! supporting both native Rust and WASM targets.
//!
//! # Features
//!
//! - `native` (default): Enables native Rust runtime with tokio
//! - `wasm`: Enables WASM build with JavaScript interop
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos::{AgentRuntime, Character, parse_character};
//! use elizaos::runtime::RuntimeOptions;
//!
//! async fn example() -> anyhow::Result<()> {
//!     let character = parse_character(r#"{"name": "TestAgent", "bio": "A test agent"}"#)?;
//!     let runtime = AgentRuntime::new(RuntimeOptions {
//!         character: Some(character),
//!         ..Default::default()
//!     }).await?;
//!     runtime.initialize().await?;
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![warn(rustdoc::missing_crate_level_docs)]

pub mod character;
pub mod plugin;
pub mod prompts;
pub mod runtime;
pub mod services;
pub mod settings;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

// Re-export commonly used items at the crate root for convenience
pub use character::{
    build_character_plugins, merge_character_defaults, parse_character, validate_character,
};
pub use runtime::AgentRuntime;
pub use types::agent::{Agent, AgentStatus, Bio, Character};
pub use types::primitives::UUID;

/// Initialize the library (sets up panic hooks for WASM, logging, etc.)
pub fn init() {
    #[cfg(feature = "wasm")]
    {
        console_error_panic_hook::set_once();
    }

    // Tracing is optional and only initialized if tracing-subscriber is available
}

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
