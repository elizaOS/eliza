//! elizaOS Cross-Language Interop - Rust
//!
//! This module provides utilities for:
//! - Exporting Rust plugins via FFI for Python
//! - Exporting Rust plugins via WASM for TypeScript
//! - Loading plugins from other languages (future)

pub mod ffi_exports;

#[cfg(feature = "wasm")]
pub mod wasm_plugin;

// Re-export commonly used items
pub use ffi_exports::{register_plugin, PluginExport};

#[cfg(feature = "wasm")]
pub use wasm_plugin::{
    register_wasm_plugin, ActionManifest, ActionResult, EvaluatorManifest, PluginManifest,
    ProviderManifest, ProviderResult, WasmPlugin,
};

