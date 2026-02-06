//! Experience learning plugin for elizaOS agents (Rust).
//!
//! Provides:
//! - Experience types and query structures
//! - In-memory experience service
//! - Action for recording experiences
//! - Provider for injecting relevant experiences into context
//! - Evaluator for extracting novel experiences from conversation
//! - Prompt template helpers for extracting experiences

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Record experience action.
pub mod action;
/// Experience evaluator for extracting learnings from conversation.
pub mod evaluator;
/// Prompt builder utilities.
pub mod prompts;
/// Experience context provider.
pub mod provider;
/// In-memory service for recording/querying experiences.
pub mod service;
/// Type definitions for experiences and queries.
pub mod types;

mod generated;

pub use action::*;
pub use evaluator::*;
pub use prompts::*;
pub use provider::*;
pub use service::*;
pub use types::*;
