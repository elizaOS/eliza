#![allow(missing_docs)]
//! Vision plugin for elizaOS
//!
//! Provides camera integration and visual awareness capabilities.

#![deny(missing_docs)]

/// Plugin module
pub mod plugin;

/// Types module
pub mod types;

/// Error types
pub mod error;

pub use plugin::VisionPlugin;
pub use types::*;
pub use error::VisionError;

