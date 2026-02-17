//! ElizaCloud plugin for the elizaOS runtime.
//!
//! This plugin provides integration with ElizaCloud services including
//! multi-model AI generation, container provisioning, agent bridge,
//! and billing management.

#![warn(missing_docs)]
#![deny(unsafe_code)]

pub mod error;
pub mod models;
pub mod providers;
pub mod types;

// Cloud integration modules
pub mod actions;
pub mod cloud_api;
pub mod cloud_providers;
pub mod cloud_types;
pub mod services;

#[cfg(feature = "wasm")]
pub mod wasm;

/// The name of this plugin.
pub const PLUGIN_NAME: &str = "elizacloud";

/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
