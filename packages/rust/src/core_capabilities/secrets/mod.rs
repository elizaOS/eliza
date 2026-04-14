//! Secrets Manager capability — multi-level secret storage, encryption, and access control.
//!
//! Ports the TypeScript `plugin-secrets-manager` module, providing:
//! - Secret types, config, contexts, and access logging
//! - AES-256-GCM encryption (crypto module)
//! - SecretsService for secret lifecycle management
//! - SET_SECRET, GET_SECRET, DELETE_SECRET actions
//! - SECRETS_STATUS provider

pub mod actions;
pub mod crypto;
pub mod providers;
pub mod service;
pub mod types;

pub use actions::{DeleteSecretAction, GetSecretAction, SetSecretAction};
pub use providers::SecretsStatusProvider;
pub use service::SecretsService;
pub use types::*;
