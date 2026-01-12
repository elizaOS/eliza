//! # Memory Plugin
//!
//! This crate provides memory management capabilities for the ElizaOS agent framework,
//! including conversation summarization and long-term persistent memory storage.
//!
//! ## Features
//!
//! - **Conversation Summarization**: Automatically summarizes conversations to optimize context usage
//! - **Long-term Memory Extraction**: Extracts and stores persistent facts about users
//! - **Memory Providers**: Provides formatted memory context for agent interactions
//!
//! ## Usage
//!
//! ```rust,ignore
//! use elizaos_plugin_memory::{MemoryConfig, MemoryService};
//!
//! let config = MemoryConfig::default();
//! let service = MemoryService::new(config);
//! ```

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// Configuration module for memory plugin settings.
/// Configuration module for memory plugin settings.
pub mod config;
/// Error types and result definitions.
pub mod error;
/// Evaluators for memory extraction and summarization.
pub mod evaluators;
/// Providers for memory context in agent interactions.
pub mod providers;
pub mod service;
pub mod types;

#[cfg(feature = "wasm")]
pub mod wasm;

pub use config::MemoryConfig;
pub use error::{MemoryError, Result};
pub use evaluators::{
    EvaluatorContext, EvaluatorResult, LongTermExtractionEvaluator, MemoryEvaluator,
    SummarizationEvaluator,
};
pub use providers::{
    ContextSummaryProvider, LongTermMemoryProvider, MemoryProvider, ProviderContext, ProviderResult,
};
pub use service::MemoryService;
pub use types::{
    LongTermMemory, LongTermMemoryCategory, MemoryExtraction, SessionSummary, SummaryResult,
};

/// The name identifier for this plugin.
pub const PLUGIN_NAME: &str = "memory";
/// A human-readable description of this plugin's functionality.
pub const PLUGIN_DESCRIPTION: &str =
    "Memory management with conversation summarization and long-term persistent memory";
/// The version of this plugin, derived from Cargo.toml.
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
