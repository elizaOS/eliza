//! Trajectory logging utilities for elizaOS agents (Rust).
//!
//! Provides:
//! - In-memory trajectory logger service
//! - ART / GRPO formatting helpers
//! - Heuristic reward scoring helpers

#![warn(missing_docs)]
#![deny(unsafe_code)]

/// ART formatting helpers.
pub mod art_format;
/// Export helpers (JSONL / grouped JSON).
pub mod export;
/// Heuristic reward scoring.
pub mod reward_service;
/// In-memory trajectory collector.
pub mod service;
/// Shared types.
pub mod types;

pub use art_format::*;
pub use export::*;
pub use reward_service::*;
pub use service::*;
pub use types::*;
