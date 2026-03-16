#![allow(missing_docs)]
#![deny(unsafe_code)]

pub mod client;
pub mod config;
pub mod error;
pub mod types;

#[cfg(feature = "native")]
pub mod service;

#[cfg(feature = "native")]
pub mod actions;

#[cfg(feature = "native")]
pub mod providers;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use client::FarcasterClient;
pub use config::FarcasterConfig;
pub use error::{FarcasterError, Result};
pub use types::{Cast, Profile};

#[cfg(feature = "native")]
pub use service::FarcasterService;

#[cfg(feature = "native")]
pub use actions::{ActionResult, ReplyCastAction, SendCastAction};

#[cfg(feature = "native")]
pub use providers::{
    ProfileProvider, ProviderResult, ThreadProvider, TimelineProvider,
};

pub fn create_client_from_env() -> Result<FarcasterClient> {
    let config = FarcasterConfig::from_env()?;
    FarcasterClient::new(config)
}

pub const PLUGIN_NAME: &str = "farcaster";
pub const PLUGIN_DESCRIPTION: &str =
    "Farcaster integration for elizaOS - sending and receiving casts via Neynar API";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const FARCASTER_SERVICE_NAME: &str = "farcaster";
pub const FARCASTER_SOURCE: &str = "farcaster";

pub mod defaults {
    pub const MAX_CAST_LENGTH: usize = 320;
    pub const POLL_INTERVAL: u64 = 120;
    pub const CAST_INTERVAL_MIN: u64 = 90;
    pub const CAST_INTERVAL_MAX: u64 = 180;
    pub const CAST_CACHE_TTL: u64 = 1000 * 30 * 60;
    pub const CAST_CACHE_SIZE: usize = 9000;
}

/// Descriptor for the full plugin, listing all actions, providers, and
/// services that ship with this crate.
#[cfg(feature = "native")]
pub struct FarcasterPlugin;

#[cfg(feature = "native")]
impl FarcasterPlugin {
    pub fn name() -> &'static str {
        PLUGIN_NAME
    }

    pub fn description() -> &'static str {
        PLUGIN_DESCRIPTION
    }

    pub fn version() -> &'static str {
        PLUGIN_VERSION
    }

    /// Return descriptors for every action registered in this plugin.
    pub fn actions() -> Vec<(&'static str, &'static str)> {
        actions::all_action_names()
    }

    /// Return descriptors for every provider registered in this plugin.
    pub fn providers() -> Vec<(&'static str, &'static str)> {
        providers::all_provider_names()
    }
}
