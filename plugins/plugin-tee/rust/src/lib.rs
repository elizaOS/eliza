#![allow(missing_docs)]
#![deny(unsafe_code)]

pub mod actions;
pub mod client;
pub mod error;
pub mod providers;
pub mod services;
pub mod types;
pub mod utils;
pub mod vendors;

pub use types::{TeeMode, TeeVendor};
pub use utils::{bytes_to_hex, calculate_sha256, get_tee_endpoint, hex_to_bytes};

pub const PLUGIN_NAME: &str = "tee";
pub const PLUGIN_DESCRIPTION: &str =
    "TEE integration plugin for secure key management and remote attestation";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
