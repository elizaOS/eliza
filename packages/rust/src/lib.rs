//! elizaOS Core - Rust Implementation
//!
//! This crate provides the core runtime and types for elizaOS, a framework for building
//! AI agents. It is designed to be fully compatible with the TypeScript implementation,
//! supporting both native Rust and WASM targets.
//!
//! # Features
//!
//! - `native` (default): Enables native Rust runtime with tokio
//! - `wasm`: Enables WASM build with JavaScript interop
//!
//! # Example
//!
//! ```rust,no_run
//! use elizaos::{AgentRuntime, Character, parse_character};
//! use elizaos::runtime::RuntimeOptions;
//!
//! async fn example() -> anyhow::Result<()> {
//!     let character = parse_character(r#"{"name": "TestAgent", "bio": "A test agent"}"#)?;
//!     let runtime = AgentRuntime::new(RuntimeOptions {
//!         character: Some(character),
//!         ..Default::default()
//!     }).await?;
//!     runtime.initialize().await?;
//!     Ok(())
//! }
//! ```

#![warn(missing_docs)]
#![warn(rustdoc::missing_crate_level_docs)]

#[cfg(all(
    feature = "bootstrap-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod advanced_capabilities;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod advanced_memory;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod advanced_planning;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod autonomy;
#[cfg(all(
    feature = "bootstrap-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod basic_capabilities;
#[cfg(all(
    feature = "bootstrap-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod bootstrap;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod bootstrap_core;
pub mod character;
#[cfg(all(
    feature = "bootstrap-internal",
    feature = "native",
    not(feature = "wasm")
))]
pub mod error;
pub mod platform;
pub mod plugin;
pub mod prompts;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod runtime;
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub mod services;
pub mod settings;
pub mod template;
pub mod types;
pub mod xml;

/// Auto-generated action/provider/evaluator docs from centralized specs
#[allow(missing_docs)]
pub mod generated;

#[cfg(feature = "wasm")]
pub mod wasm;

/// Synchronous runtime for environments without async (ICP, embedded, WASI)
pub mod sync_runtime;

// Re-export commonly used items at the crate root for convenience
pub use character::{
    build_character_plugins, merge_character_defaults, parse_character, validate_character,
};
#[cfg(all(feature = "native", not(feature = "wasm")))]
pub use runtime::AgentRuntime;

// Re-export agent types
pub use types::agent::{Agent, AgentStatus, Bio, Character};

// Re-export primitive types
pub use types::primitives::{Content, Metadata, UUID};

// Re-export environment types (entities, rooms, worlds, etc.)
pub use types::environment::{Component, Entity, Relationship, Room, World, WorldMetadata};

// Re-export memory types
pub use types::memory::{Memory, MemoryMetadata};

// Re-export database types (logs, query params, etc.)
pub use types::database::{GetMemoriesParams, Log, LogBody, SearchMemoriesParams};

// Re-export task types
pub use types::task::{Task, TaskStatus};

// Re-export plugin types
pub use types::plugin::Plugin;

// Re-export platform utilities
pub use platform::{AnyArc, PlatformService};

// Re-export unified runtime (works in both sync and async modes)
pub use sync_runtime::{
    // Backward compatibility aliases
    DatabaseAdapterSync,
    // Event handler type
    EventHandler as UnifiedEventHandler,
    SyncAgentRuntime,
    SyncMessageProcessingResult,
    SyncMessageService,
    SyncModelHandler,
    // Unified handler traits
    UnifiedActionHandler,
    // Unified types (primary API)
    UnifiedDatabaseAdapter,
    UnifiedEvaluatorHandler,
    UnifiedMessageProcessingOptions,
    UnifiedMessageProcessingResult,
    UnifiedMessageService,
    UnifiedModelHandler,
    UnifiedProviderHandler,
    UnifiedProviderResult,
    UnifiedRuntime,
    UnifiedRuntimeOptions,
    UnifiedService,
};

// Re-export generated action/evaluator docs from centralized specs
pub use generated::action_docs::{
    ALL_ACTION_DOCS_JSON, ALL_EVALUATOR_DOCS_JSON, CORE_ACTION_DOCS_JSON, CORE_EVALUATOR_DOCS_JSON,
};

/// Initialize the library (sets up panic hooks for WASM, logging, etc.)
pub fn init() {
    #[cfg(feature = "wasm")]
    {
        console_error_panic_hook::set_once();
    }

    // Tracing is optional and only initialized if tracing-subscriber is available
}

/// Library version
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
