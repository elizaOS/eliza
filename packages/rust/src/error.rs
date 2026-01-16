//! Plugin error types (compat re-export).
//!
//! The bootstrap plugin defines `PluginError` / `PluginResult` for use by built-in
//! actions/providers. Historically these were imported as `crate::error::*`.
//! This module preserves that public path.

pub use crate::bootstrap::error::{PluginError, PluginResult};
