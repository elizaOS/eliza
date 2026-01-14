//! Experience learning plugin for elizaOS agents (Rust).
//!
//! Provides:
//! - Experience types and query structures
//! - In-memory experience service
//! - Prompt template helpers for extracting experiences

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Prompt builder utilities.
pub mod prompts;
/// In-memory service for recording/querying experiences.
pub mod service;
/// Type definitions for experiences and queries.
pub mod types;

mod generated;

pub use prompts::*;
pub use service::*;
pub use types::*;
