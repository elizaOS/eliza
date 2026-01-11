//! elizaOS Cross-Language Interop - Rust
//!
//! This module provides utilities for:
//! - Exporting Rust plugins via FFI for Python
//! - Exporting Rust plugins via WASM for TypeScript
//! - Loading TypeScript plugins via IPC
//! - Loading Python plugins via IPC
//!
//! Import directly from submodules:
//! - ffi_exports for FFI export utilities
//! - ts_loader for TypeScript plugin loading
//! - py_loader for Python plugin loading
//! - wasm_plugin for WASM plugin support (with "wasm" feature)

pub mod ffi_exports;
pub mod ts_loader;
pub mod py_loader;

#[cfg(feature = "wasm")]
pub mod wasm_plugin;

