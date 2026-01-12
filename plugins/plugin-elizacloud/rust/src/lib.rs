//! ElizaCloud plugin for the ElizaOS runtime.
//!
//! This plugin provides integration with ElizaCloud services.

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod error;
pub mod models;
pub mod providers;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

/// The name of this plugin.
pub const PLUGIN_NAME: &str = "elizacloud";

/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
