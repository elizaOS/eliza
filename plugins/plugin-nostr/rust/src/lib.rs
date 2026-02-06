//! Nostr Plugin for ElizaOS
//!
//! Provides Nostr decentralized messaging integration for ElizaOS agents,
//! supporting encrypted DMs via NIP-04 and profile management.

pub mod types;
pub mod service;
pub mod actions;
pub mod providers;

// Re-export main types
pub use types::*;
pub use service::NostrService;
pub use actions::*;
pub use providers::*;
