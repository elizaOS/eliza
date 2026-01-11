//! elizaOS Cross-Language Interop - Rust
//!
//! This module provides utilities for:
//! - Exporting Rust plugins via FFI for Python
//! - Exporting Rust plugins via WASM for TypeScript
//! - Loading TypeScript plugins via IPC
//! - Loading Python plugins via IPC

pub mod ffi_exports;
pub mod ts_loader;
pub mod py_loader;

#[cfg(feature = "wasm")]
pub mod wasm_plugin;

// Re-export commonly used items
pub use ffi_exports::{register_plugin, PluginExport};

// TypeScript loader
pub use ts_loader::{
    TypeScriptPluginBridge, TypeScriptManifest,
    ActionResult as TsActionResult, ProviderResult as TsProviderResult,
};

// Python loader
pub use py_loader::{
    PythonPluginBridge, PythonManifest,
};

#[cfg(feature = "wasm")]
pub use wasm_plugin::{
    register_wasm_plugin, ActionManifest, ActionResult, EvaluatorManifest, PluginManifest,
    ProviderManifest, ProviderResult, WasmPlugin,
};

