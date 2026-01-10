//! elizaOS Forms Plugin - Structured conversational data collection
//!
//! This plugin provides form management capabilities for collecting structured data
//! from users through natural conversation.

pub mod types;
pub mod prompts;
pub mod service;
pub mod error;
mod generated;

pub use types::*;
pub use prompts::*;
pub use service::*;
pub use error::*;

